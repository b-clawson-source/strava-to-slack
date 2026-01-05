import express from "express";
import "dotenv/config";
import fetch from "node-fetch";
import polyline from "@mapbox/polyline";
import FormData from "form-data";
import {
  upsertConnection,
  listConnections,
  getConnection,
  wasActivityPosted,
  markActivityPosted,
} from "./db.js";

const app = express();
app.use(express.json({ type: "*/*" }));

app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Strava to Slack - Setup</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          max-width: 600px;
          margin: 50px auto;
          padding: 20px;
          line-height: 1.6;
        }
        h1 { color: #333; }
        .card {
          background: #f5f5f5;
          padding: 20px;
          border-radius: 8px;
          margin: 20px 0;
        }
        input {
          width: 100%;
          padding: 10px;
          font-size: 16px;
          border: 2px solid #ddd;
          border-radius: 4px;
          box-sizing: border-box;
        }
        button {
          background: #FC4C02;
          color: white;
          padding: 12px 24px;
          font-size: 16px;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          width: 100%;
          margin-top: 10px;
        }
        button:hover { background: #E34402; }
        button:disabled {
          background: #ccc;
          cursor: not-allowed;
        }
        .instructions {
          background: #e8f4fd;
          padding: 15px;
          border-left: 4px solid #2196F3;
          margin: 20px 0;
        }
        .instructions ol { margin: 10px 0; padding-left: 20px; }
        code {
          background: #333;
          color: #fff;
          padding: 2px 6px;
          border-radius: 3px;
          font-family: monospace;
        }
      </style>
    </head>
    <body>
      <h1>🏃 Strava to Slack</h1>
      <p>Connect your Strava account to automatically post your runs to Slack.</p>

      <div class="instructions">
        <strong>First, get your Slack Member ID:</strong>
        <ol>
          <li>Open Slack and click on your profile picture</li>
          <li>Click "View profile"</li>
          <li>Click the ⋯ (three dots) menu</li>
          <li>Click "Copy member ID"</li>
        </ol>
        <p>Your Slack ID will look like: <code>U04HBADQP0B</code></p>
      </div>

      <div class="card">
        <form id="setupForm">
          <label for="slackId"><strong>Your Slack Member ID:</strong></label>
          <input
            type="text"
            id="slackId"
            name="slackId"
            placeholder="U04HBADQP0B"
            pattern="U[A-Z0-9]{10,}"
            required
          />
          <button type="submit" id="submitBtn">Connect Strava Account</button>
        </form>
      </div>

      <script>
        document.getElementById('setupForm').addEventListener('submit', (e) => {
          e.preventDefault();
          const slackId = document.getElementById('slackId').value.trim();
          if (slackId) {
            window.location.href = '/auth/strava/start?slack_user_id=' + encodeURIComponent(slackId);
          }
        });
      </script>
    </body>
    </html>
  `);
});

/**
 * TEST: Slack post with pedometer format (sends to DM)
 */
app.post("/test/slack", async (req, res) => {
  try {
    const token = process.env.SLACK_BOT_TOKEN;
    const mySlackUserId = process.env.MY_SLACK_USER_ID;
    const pedometerUserId = process.env.FETCH_PEDOMETER_USER_ID;

    if (!token || !mySlackUserId) {
      return res.status(400).json({
        ok: false,
        error: "Missing SLACK_BOT_TOKEN or MY_SLACK_USER_ID",
      });
    }

    const text =
      `<@${pedometerUserId}> +3.45 mile 🏃\n` +
      `<@${mySlackUserId}> *Brandt Clawson*: Test Run\n` +
      `https://www.strava.com/activities/12345678`;

    const resp = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: mySlackUserId, text }),
    });

    const data = await resp.json();

    if (!data.ok) {
      return res.status(500).json({ ok: false, slack_error: data.error, data });
    }

    res.json({ ok: true, ts: data.ts, message: "Test post sent to your DM" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * TEST: Map image with a real Strava activity
 * Sends to your DM instead of the channel
 * Usage: POST /test/map-dm { "activity_id": "12345678", "athlete_id": 19826530 }
 */
app.post("/test/map-dm", async (req, res) => {
  try {
    const { activity_id, athlete_id } = req.body;
    if (!activity_id) {
      return res.status(400).json({ ok: false, error: "Missing activity_id in body" });
    }

    const mySlackUserId = process.env.MY_SLACK_USER_ID;
    if (!mySlackUserId) {
      return res.status(400).json({ ok: false, error: "Missing MY_SLACK_USER_ID in .env" });
    }

    // Get connection for the specified athlete (or first one)
    let conn;
    if (athlete_id) {
      conn = await getConnection(athlete_id);
    } else {
      const connections = await listConnections();
      if (connections.length === 0) {
        return res.status(400).json({ ok: false, error: "No Strava connections found" });
      }
      conn = connections[0];
    }

    if (!conn) {
      return res.status(404).json({ ok: false, error: "Athlete connection not found" });
    }

    // Refresh token and update connection
    const refreshed = await refreshStravaToken(conn.refresh_token);

    await upsertConnection({
      athlete_id: conn.athlete_id,
      refresh_token: refreshed.refresh_token,
      access_token: refreshed.access_token,
      expires_at: refreshed.expires_at,
      athlete_firstname: refreshed.athlete?.firstname || conn.athlete_firstname,
      athlete_lastname: refreshed.athlete?.lastname || conn.athlete_lastname,
      slack_user_id: conn.slack_user_id,
    });

    // Fetch activity
    const activity = await getStravaActivity(refreshed.access_token, activity_id);

    // Generate map URL
    const mapUrl = activity.map?.summary_polyline
      ? generateMapboxStaticImageUrl(activity.map.summary_polyline)
      : null;

    if (!mapUrl) {
      return res.json({
        ok: false,
        error: "No map data or Mapbox token not configured",
        has_map: !!activity.map,
        has_polyline: !!activity.map?.summary_polyline,
      });
    }

    // Post to DM with map link first (simpler test)
    const distanceLine = pedometerLineFromMeters(activity.distance);
    const text = `🧪 *Map Test*\n${distanceLine}\n${activity.name}\n\nMap URL: ${mapUrl}`;

    // Send DM with map link
    const token = process.env.SLACK_BOT_TOKEN;
    const dmResp = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: mySlackUserId, text }),
    });

    const dmData = await dmResp.json();
    if (!dmData.ok) {
      return res.json({ ok: false, error: `DM failed: ${dmData.error}`, map_url: mapUrl });
    }

    res.json({ ok: true, map_url: mapUrl, slack_response: dmData });
  } catch (err) {
    console.error("Map test error:", err);
    res.status(500).json({ ok: false, error: err.message, stack: err.stack });
  }
});

function milesFromMeters(meters) {
  return meters / 1609.344;
}

function pedometerLineFromMeters(meters) {
  const pedometerUserId = process.env.FETCH_PEDOMETER_USER_ID;
  const miles = milesFromMeters(meters);
  return `<@${pedometerUserId}> +${miles.toFixed(2)} mile`;
}

async function refreshStravaToken(refresh_token) {
  const client_id = process.env.STRAVA_CLIENT_ID;
  const client_secret = process.env.STRAVA_CLIENT_SECRET;

  const resp = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      client_id,
      client_secret,
      grant_type: "refresh_token",
      refresh_token,
    }),
  });

  const raw = await resp.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { raw };
  }

  if (!resp.ok || data?.errors) {
    throw new Error(`Strava refresh failed: ${JSON.stringify(data)}`);
  }

  return data; // contains access_token, refresh_token (may rotate), expires_at, athlete
}

async function getStravaActivity(access_token, activityId) {
  const resp = await fetch(`https://www.strava.com/api/v3/activities/${activityId}`, {
    headers: { Authorization: `Bearer ${access_token}` },
  });

  const raw = await resp.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { raw };
  }

  if (!resp.ok || data?.errors) {
    throw new Error(`Strava get activity failed: ${JSON.stringify(data)}`);
  }

  return data;
}

async function slackPostMessage(text) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;

  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, text }),
  });

  const data = await resp.json();
  if (!data.ok) throw new Error(`Slack post failed: ${data.error}`);
  return data;
}

/**
 * Generate a Mapbox Static Image URL from a Strava polyline
 */
function generateMapboxStaticImageUrl(encodedPolyline, width = 600, height = 400) {
  const mapboxToken = process.env.MAPBOX_ACCESS_TOKEN;
  if (!mapboxToken || mapboxToken === "YOUR_MAPBOX_TOKEN_HERE") {
    return null;
  }

  // Decode polyline to coordinates
  const coords = polyline.decode(encodedPolyline);

  // Convert to [lng, lat] format and create GeoJSON path
  const path = coords.map(([lat, lng]) => `${lng},${lat}`).join(",");

  // Build Mapbox static image URL with path overlay
  const url =
    `https://api.mapbox.com/styles/v1/mapbox/streets-v11/static/` +
    `path-5+f44-0.5(${encodeURIComponent(path)})/` +
    `auto/${width}x${height}@2x` +
    `?access_token=${mapboxToken}`;

  return url;
}

/**
 * Upload an image to Slack from a URL (using V2 API)
 */
async function slackUploadImageFromUrl(imageUrl, initialComment, channel) {
  const token = process.env.SLACK_BOT_TOKEN;

  // Download the image
  const imageResp = await fetch(imageUrl);
  if (!imageResp.ok) {
    throw new Error(`Failed to download image: ${imageResp.statusText}`);
  }

  const imageBuffer = await imageResp.buffer();
  const filename = "route.png";
  const filesize = imageBuffer.length;

  // Step 1: Get upload URL
  const uploadUrlResp = await fetch("https://slack.com/api/files.getUploadURLExternal", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      filename,
      length: filesize,
    }),
  });

  const uploadUrlData = await uploadUrlResp.json();
  if (!uploadUrlData.ok) {
    throw new Error(`Failed to get upload URL: ${uploadUrlData.error}`);
  }

  // Step 2: Upload file to the URL
  const uploadResp = await fetch(uploadUrlData.upload_url, {
    method: "POST",
    body: imageBuffer,
  });

  if (!uploadResp.ok) {
    throw new Error(`Failed to upload file: ${uploadResp.statusText}`);
  }

  // Step 3: Complete the upload
  const completeResp = await fetch("https://slack.com/api/files.completeUploadExternal", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      files: [
        {
          id: uploadUrlData.file_id,
          title: "Route Map",
        },
      ],
      channel_id: channel,
      initial_comment: initialComment,
    }),
  });

  const completeData = await completeResp.json();
  if (!completeData.ok) {
    throw new Error(`Failed to complete upload: ${completeData.error}`);
  }

  return completeData;
}

/**
 * Post activity to Slack with Strava link
 */
async function slackPostActivityWithMap(activity, conn) {
  const distanceLine = pedometerLineFromMeters(activity.distance);
  const athleteName =
    `${conn.athlete_firstname || ""} ${conn.athlete_lastname || ""}`.trim() || "Runner";
  const title = activity.name || "New Run";
  const stravaUrl = `https://www.strava.com/activities/${activity.id}`;

  // Include Slack user mention if mapped
  const userMention = conn.slack_user_id ? `<@${conn.slack_user_id}> ` : "";

  const text =
    `${distanceLine} 🏃\n` +
    `${userMention}*${athleteName}*: ${title}\n` +
    `${stravaUrl}`;

  return await slackPostMessage(text);
}

/**
 * STRAVA OAUTH: Start
 * Teammates visit this URL to connect their Strava account.
 * Query param: slack_user_id (optional but recommended)
 */
app.get("/auth/strava/start", (req, res) => {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const redirectUri = process.env.STRAVA_REDIRECT_URI;
  const slackUserId = req.query.slack_user_id;

  if (!clientId || !redirectUri) {
    return res
      .status(400)
      .send("Missing STRAVA_CLIENT_ID or STRAVA_REDIRECT_URI in .env");
  }

  // Pass slack_user_id through OAuth state parameter
  const state = slackUserId ? JSON.stringify({ slack_user_id: slackUserId }) : "";

  const scope = encodeURIComponent("read,activity:read_all");
  const url =
    `https://www.strava.com/oauth/authorize` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&approval_prompt=auto` +
    `&scope=${scope}` +
    (state ? `&state=${encodeURIComponent(state)}` : "");

  res.redirect(url);
});

/**
 * STRAVA OAUTH: Callback
 * Exchanges "code" for access/refresh tokens and stores them by athlete_id.
 * Extracts slack_user_id from state parameter if provided.
 *
 * NOTE: We read the response body ONCE (via .text()), then JSON.parse it.
 */
app.get("/auth/strava/callback", async (req, res) => {
  try {
    const code = req.query.code;
    const state = req.query.state;

    if (!code) return res.status(400).send("Missing code");

    // Extract slack_user_id from state if provided
    let slackUserId = null;
    if (state) {
      try {
        const stateData = JSON.parse(state);
        slackUserId = stateData.slack_user_id;
      } catch {
        console.warn("Failed to parse state parameter:", state);
      }
    }

    const client_id = process.env.STRAVA_CLIENT_ID;
    const client_secret = process.env.STRAVA_CLIENT_SECRET;

    if (!client_id || !client_secret) {
      return res
        .status(400)
        .send("Missing STRAVA_CLIENT_ID or STRAVA_CLIENT_SECRET in .env");
    }

    const tokenResp = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        client_id,
        client_secret,
        code,
        grant_type: "authorization_code",
      }),
    });

    const raw = await tokenResp.text();
    console.log("Strava token exchange status:", tokenResp.status);

    let tokenData;
    try {
      tokenData = JSON.parse(raw);
    } catch {
      tokenData = { raw };
    }

    console.log("Strava token exchange success for athlete:", tokenData?.athlete?.id);

    if (!tokenResp.ok || tokenData?.errors) {
      return res
        .status(500)
        .send(`Strava token exchange failed: ${JSON.stringify(tokenData)}`);
    }

    const athlete = tokenData.athlete;
    await upsertConnection({
      athlete_id: athlete.id,
      refresh_token: tokenData.refresh_token,
      access_token: tokenData.access_token,
      expires_at: tokenData.expires_at,
      athlete_firstname: athlete.firstname,
      athlete_lastname: athlete.lastname,
      slack_user_id: slackUserId,
    });

    const slackMsg = slackUserId
      ? `Your Slack account (<@${slackUserId}>) will be mentioned in activity posts.`
      : `Note: No Slack account linked. Visit the homepage to set up your Slack ID.`;

    res.send(
      `Connected! ✅\n\nAthlete: ${athlete.firstname} ${athlete.lastname} (id ${athlete.id}).\n\n${slackMsg}\n\nYou can close this tab.`
    );
  } catch (err) {
    console.error("Callback error:", err);
    res.status(500).send(err.message);
  }
});

/**
 * Admin-ish: List who has connected
 */
app.get("/connections", async (req, res) => {
  const rows = await listConnections();
  res.json({ ok: true, connections: rows });
});

/**
 * Update Slack user ID for a Strava athlete
 * POST /connections/:athlete_id/slack
 * Body: { "slack_user_id": "U04HBADQP0B" }
 */
app.post("/connections/:athlete_id/slack", async (req, res) => {
  try {
    const athleteId = parseInt(req.params.athlete_id, 10);
    const { slack_user_id } = req.body;

    if (!slack_user_id) {
      return res.status(400).json({ ok: false, error: "Missing slack_user_id in body" });
    }

    const conn = await getConnection(athleteId);
    if (!conn) {
      return res.status(404).json({ ok: false, error: "Athlete not found" });
    }

    await upsertConnection({
      athlete_id: athleteId,
      refresh_token: conn.refresh_token,
      access_token: conn.access_token,
      expires_at: conn.expires_at,
      athlete_firstname: conn.athlete_firstname,
      athlete_lastname: conn.athlete_lastname,
      slack_user_id,
    });

    res.json({ ok: true, message: "Slack user ID updated" });
  } catch (err) {
    console.error("Update Slack ID error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/strava/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.STRAVA_VERIFY_TOKEN) {
    return res.json({ "hub.challenge": challenge });
  }

  return res.status(403).send("Verification failed");
});

app.post("/strava/webhook", async (req, res) => {
  // ACK immediately so Strava doesn't retry
  res.status(200).send("EVENT_RECEIVED");

  try {
    const event = req.body;
    console.log("Received webhook event:", event);

    // Only care about newly created activities
    if (event?.object_type !== "activity" || event?.aspect_type !== "create") return;

    const activityId = event.object_id;
    const athleteId = event.owner_id;

    // Idempotency: don't double-post
    if (await wasActivityPosted(activityId)) {
      console.log("Already posted activity:", activityId);
      return;
    }

    const conn = await getConnection(athleteId);
    if (!conn) {
      console.log(`No connection found for athlete_id=${athleteId}. Skipping.`);
      return;
    }

    // Refresh token (Strava may rotate refresh_token)
    const refreshed = await refreshStravaToken(conn.refresh_token);

    await upsertConnection({
      athlete_id: athleteId,
      refresh_token: refreshed.refresh_token,
      access_token: refreshed.access_token,
      expires_at: refreshed.expires_at,
      athlete_firstname: refreshed.athlete?.firstname || conn.athlete_firstname,
      athlete_lastname: refreshed.athlete?.lastname || conn.athlete_lastname,
    });

    // Fetch activity details
    const activity = await getStravaActivity(refreshed.access_token, activityId);

    console.log("Fetched activity:", {
      id: activity.id,
      type: activity.type,
      distance: activity.distance,
      name: activity.name,
    });

    // Only runs
    if (activity.type !== "Run") {
      console.log("Not a Run. Skipping. type=", activity.type);
      return;
    }

    // Post activity with map image (or without if no map available)
    const slackResp = await slackPostActivityWithMap(activity, conn);
    console.log("Slack post ok:", { ts: slackResp.ts || slackResp.file?.id });

    await markActivityPosted(activityId, athleteId);
    console.log(`Posted run activity ${activityId} for athlete ${athleteId}`);
  } catch (err) {
    console.error("Webhook processing error:", err);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});