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
  verifySlackUser,
  getConnectionByVerificationToken,
  // Standalone Slack verification
  upsertVerifiedSlackUser,
  getVerifiedSlackUser,
  isSlackUserVerified,
  verifySlackUserStandalone,
  getVerifiedSlackUserByToken,
  // Peloton
  upsertPelotonConnection,
  getPelotonConnection,
  getPelotonConnectionBySlackId,
  listPelotonConnections,
  deletePelotonConnection,
  markPelotonWorkoutPosted,
  wasPelotonWorkoutPosted,
} from "./db.js";
import crypto from "crypto";

const app = express();
app.use(express.json({ type: "*/*" }));
app.use(express.urlencoded({ extended: true }));

// Admin authentication middleware
function requireAdminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const adminToken = process.env.ADMIN_TOKEN;

  if (!adminToken) {
    // If ADMIN_TOKEN is not set, allow access (backward compatibility)
    return next();
  }

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ ok: false, error: "Missing or invalid Authorization header" });
  }

  const token = authHeader.substring(7);
  if (token !== adminToken) {
    return res.status(403).json({ ok: false, error: "Invalid admin token" });
  }

  next();
}

app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Fitness to Slack - Setup</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          max-width: 700px;
          margin: 50px auto;
          padding: 20px;
          line-height: 1.6;
        }
        h1 { color: #333; }
        h2 { color: #555; margin-top: 0; }
        .card {
          background: #f5f5f5;
          padding: 20px;
          border-radius: 8px;
          margin: 20px 0;
        }
        .card.strava { border-left: 4px solid #FC4C02; }
        .card.peloton { border-left: 4px solid #DF1C2F; }
        .card.verify { border-left: 4px solid #2196F3; }
        input {
          width: 100%;
          padding: 10px;
          font-size: 16px;
          border: 2px solid #ddd;
          border-radius: 4px;
          box-sizing: border-box;
        }
        label {
          display: block;
          margin-top: 10px;
          font-weight: bold;
        }
        button {
          color: white;
          padding: 12px 24px;
          font-size: 16px;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          width: 100%;
          margin-top: 15px;
        }
        button:disabled {
          background: #ccc;
          cursor: not-allowed;
        }
        .btn-verify { background: #2196F3; }
        .btn-verify:hover { background: #1976D2; }
        .btn-strava { background: #FC4C02; }
        .btn-strava:hover { background: #E34402; }
        .btn-peloton { background: #DF1C2F; }
        .btn-peloton:hover { background: #b8182a; }
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
        .step-number {
          background: #333;
          color: white;
          border-radius: 50%;
          width: 24px;
          height: 24px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 14px;
          margin-right: 8px;
        }
        .note {
          font-size: 12px;
          color: #666;
          margin-top: 10px;
        }
        .divider {
          border-top: 1px solid #ddd;
          margin: 30px 0;
        }
      </style>
    </head>
    <body>
      <h1>🏃 Fitness to Slack</h1>
      <p>Connect your Strava or Peloton account to automatically post your workouts to Slack.</p>

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

      <!-- Step 1: Verify Slack -->
      <div class="card verify">
        <h2><span class="step-number">1</span> Verify Your Slack Account</h2>
        <p>Before connecting any fitness service, verify your Slack account. We'll send you a DM with a verification link.</p>
        <form id="verifyForm" action="/verify/slack/start" method="POST">
          <label for="verifySlackId">Your Slack Member ID:</label>
          <input
            type="text"
            id="verifySlackId"
            name="slack_user_id"
            placeholder="U04HBADQP0B"
            pattern="U[A-Z0-9]{8,}"
            required
          />
          <button type="submit" class="btn-verify">Send Verification Link</button>
        </form>
      </div>

      <div class="divider"></div>

      <!-- Step 2a: Connect Strava -->
      <div class="card strava">
        <h2><span class="step-number">2a</span> Connect Strava</h2>
        <p>Once verified, connect your Strava account to auto-post your runs.</p>
        <form id="stravaForm">
          <label for="stravaSlackId">Your Slack Member ID:</label>
          <input
            type="text"
            id="stravaSlackId"
            name="slackId"
            placeholder="U04HBADQP0B"
            pattern="U[A-Z0-9]{8,}"
            required
          />
          <button type="submit" class="btn-strava">Connect Strava Account</button>
        </form>
      </div>

      <!-- Step 2b: Connect Peloton -->
      <div class="card peloton">
        <h2><span class="step-number">2b</span> Connect Peloton</h2>
        <p>Once verified, connect your Peloton account to auto-post workouts with distance (running, cycling, walking).</p>
        <form id="pelotonForm">
          <label for="pelotonSlackId">Your Slack Member ID:</label>
          <input
            type="text"
            id="pelotonSlackId"
            name="slackId"
            placeholder="U04HBADQP0B"
            pattern="U[A-Z0-9]{8,}"
            required
          />
          <button type="submit" class="btn-peloton">Connect Peloton Account</button>
        </form>
        <p class="note">You'll enter your Peloton credentials on the next page. Your password is sent directly to Peloton and never stored.</p>
      </div>

      <script>
        document.getElementById('stravaForm').addEventListener('submit', (e) => {
          e.preventDefault();
          const slackId = document.getElementById('stravaSlackId').value.trim();
          if (slackId) {
            window.location.href = '/auth/strava/start?slack_user_id=' + encodeURIComponent(slackId);
          }
        });

        document.getElementById('pelotonForm').addEventListener('submit', (e) => {
          e.preventDefault();
          const slackId = document.getElementById('pelotonSlackId').value.trim();
          if (slackId) {
            window.location.href = '/auth/peloton/start?slack_user_id=' + encodeURIComponent(slackId);
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
app.post("/test/slack", requireAdminAuth, async (req, res) => {
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
app.post("/test/map-dm", requireAdminAuth, async (req, res) => {
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

  // Use Slack mention if available, otherwise fall back to Strava name
  const displayName = conn.slack_user_id
    ? `<@${conn.slack_user_id}>`
    : `*${athleteName}*`;

  const text =
    `${distanceLine} 🏃\n` +
    `${displayName}: ${title}\n` +
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

    const redirect_uri = process.env.STRAVA_REDIRECT_URI;
    const tokenResp = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        client_id,
        client_secret,
        code,
        grant_type: "authorization_code",
        redirect_uri,
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

    // Generate verification token if Slack user ID is provided
    const verificationToken = slackUserId ? crypto.randomBytes(32).toString("hex") : null;

    await upsertConnection({
      athlete_id: athlete.id,
      refresh_token: tokenData.refresh_token,
      access_token: tokenData.access_token,
      expires_at: tokenData.expires_at,
      athlete_firstname: athlete.firstname,
      athlete_lastname: athlete.lastname,
      slack_user_id: slackUserId,
      verification_token: verificationToken,
    });

    // Send verification DM if Slack user ID is provided
    let slackMsg;
    if (slackUserId && verificationToken) {
      const baseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
      const verifyUrl = `${baseUrl}/verify/${verificationToken}`;

      try {
        const token = process.env.SLACK_BOT_TOKEN;
        const dmText = `Hi! You've connected your Strava account to the running tracker.\n\n` +
          `To complete setup and start auto-posting your runs, please click this link to verify your Slack account:\n\n` +
          `${verifyUrl}\n\n` +
          `(If you didn't request this, you can ignore this message.)`;

        await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({ channel: slackUserId, text: dmText }),
        });

        slackMsg = `Check your Slack DMs! We've sent you a verification link to confirm your account.`;
      } catch (err) {
        console.error("Failed to send verification DM:", err);
        slackMsg = `Connected, but failed to send verification DM. Please contact an admin.`;
      }
    } else {
      slackMsg = `Note: No Slack account linked. Visit the homepage to set up your Slack ID.`;
    }

    res.send(
      `Connected! ✅\n\nAthlete: ${athlete.firstname} ${athlete.lastname} (id ${athlete.id}).\n\n${slackMsg}\n\nYou can close this tab.`
    );
  } catch (err) {
    console.error("Callback error:", err);
    res.status(500).send(err.message);
  }
});

/**
 * Verification endpoint (Strava flow)
 * Users click this link from their Slack DM to verify their account
 */
app.get("/verify/:token", async (req, res) => {
  try {
    const token = req.params.token;

    // Get connection by verification token
    const conn = await getConnectionByVerificationToken(token);

    if (!conn) {
      return res.status(404).send(
        `Verification failed: Invalid or expired verification link.`
      );
    }

    // Verify the user
    await verifySlackUser(token);

    const athleteName = `${conn.athlete_firstname || ""} ${conn.athlete_lastname || ""}`.trim();

    res.send(
      `✅ Verified!\n\n` +
      `Your Slack account is now verified. Your runs will be automatically posted to the channel.\n\n` +
      `Athlete: ${athleteName}\n` +
      `Slack ID: ${conn.slack_user_id}\n\n` +
      `You can close this tab and start running! 🏃`
    );
  } catch (err) {
    console.error("Verification error:", err);
    res.status(500).send(`Verification error: ${err.message}`);
  }
});

// ============================================================
// STANDALONE SLACK VERIFICATION (for Peloton users without Strava)
// ============================================================

/**
 * Start standalone Slack verification
 * POST /verify/slack/start
 * Body: { slack_user_id: "U..." }
 */
app.post("/verify/slack/start", async (req, res) => {
  try {
    const slackUserId = req.body.slack_user_id;

    if (!slackUserId || !slackUserId.match(/^U[A-Z0-9]{8,}$/)) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Error</title></head>
        <body style="font-family: sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
          <h1>Invalid Slack ID</h1>
          <p>Please enter a valid Slack Member ID (starts with U followed by letters/numbers).</p>
          <a href="/">← Go back</a>
        </body>
        </html>
      `);
    }

    // Check if already verified
    const existing = await getVerifiedSlackUser(slackUserId);
    if (existing?.verified) {
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Already Verified</title></head>
        <body style="font-family: sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
          <h1>✅ Already Verified!</h1>
          <p>Your Slack account is already verified. You can now connect Strava or Peloton.</p>
          <a href="/">← Go back to connect services</a>
        </body>
        </html>
      `);
    }

    // Generate verification token
    const verificationToken = crypto.randomBytes(32).toString("hex");

    // Save to database
    await upsertVerifiedSlackUser({
      slack_user_id: slackUserId,
      verification_token: verificationToken,
    });

    // Send verification DM
    const baseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    const verifyUrl = `${baseUrl}/verify/slack/${verificationToken}`;

    const token = process.env.SLACK_BOT_TOKEN;
    const dmText = `Hi! You've requested to verify your Slack account for the fitness tracker.\n\n` +
      `Click this link to complete verification:\n\n` +
      `${verifyUrl}\n\n` +
      `Once verified, you can connect Strava or Peloton to auto-post your workouts.`;

    const dmResp = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: slackUserId, text: dmText }),
    });

    const dmData = await dmResp.json();
    if (!dmData.ok) {
      console.error("Failed to send verification DM:", dmData.error);
      return res.status(500).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Error</title></head>
        <body style="font-family: sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
          <h1>Failed to send verification</h1>
          <p>Could not send a DM to that Slack ID. Please check the ID is correct and that you can receive DMs from the bot.</p>
          <p>Error: ${dmData.error}</p>
          <a href="/">← Go back</a>
        </body>
        </html>
      `);
    }

    res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>Check Your Slack DMs</title></head>
      <body style="font-family: sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
        <h1>📬 Check Your Slack DMs!</h1>
        <p>We've sent a verification link to your Slack direct messages.</p>
        <p>Click the link in that message to verify your account, then come back here to connect Strava or Peloton.</p>
        <a href="/">← Go back</a>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("Slack verification start error:", err);
    res.status(500).send(`Error: ${err.message}`);
  }
});

/**
 * Complete standalone Slack verification
 * GET /verify/slack/:token
 */
app.get("/verify/slack/:token", async (req, res) => {
  try {
    const token = req.params.token;

    // Get user by verification token
    const user = await getVerifiedSlackUserByToken(token);

    if (!user) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Verification Failed</title></head>
        <body style="font-family: sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
          <h1>Verification Failed</h1>
          <p>Invalid or expired verification link.</p>
          <a href="/">← Go back to start over</a>
        </body>
        </html>
      `);
    }

    // Verify the user
    await verifySlackUserStandalone(token);

    res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>Verified!</title></head>
      <body style="font-family: sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
        <h1>✅ Verified!</h1>
        <p>Your Slack account <strong>${user.slack_user_id}</strong> is now verified.</p>
        <p>You can now connect Strava or Peloton to auto-post your workouts.</p>
        <a href="/">← Connect your fitness services</a>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("Slack verification error:", err);
    res.status(500).send(`Verification error: ${err.message}`);
  }
});

// ============================================================
// PELOTON API HELPERS
// NOTE: These use Peloton's unofficial API which may change without notice
// ============================================================

/**
 * Login to Peloton and get session credentials
 * @param {string} username - Peloton username or email
 * @param {string} password - Peloton password (never stored)
 * @returns {Promise<{session_id: string, user_id: string}>}
 */
async function pelotonLogin(username, password) {
  const resp = await fetch("https://api.onepeloton.com/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username_or_email: username,
      password: password,
    }),
  });

  const data = await resp.json();

  if (!resp.ok || !data.session_id) {
    throw new Error(data.message || "Peloton login failed");
  }

  return {
    session_id: data.session_id,
    user_id: data.user_id,
  };
}

/**
 * Get recent Peloton workouts for a user
 * @param {string} session_id - Peloton session cookie
 * @param {string} user_id - Peloton user ID
 * @param {number} limit - Max workouts to fetch (default 10)
 * @returns {Promise<Array>} - Array of workout summaries
 */
async function getPelotonWorkouts(session_id, user_id, limit = 10) {
  const resp = await fetch(
    `https://api.onepeloton.com/api/user/${user_id}/workouts?limit=${limit}&page=0`,
    {
      headers: {
        Cookie: `peloton_session_id=${session_id}`,
      },
    }
  );

  if (resp.status === 401) {
    const error = new Error("Peloton session expired");
    error.code = "SESSION_EXPIRED";
    throw error;
  }

  const data = await resp.json();

  if (!resp.ok) {
    throw new Error(data.message || "Failed to fetch Peloton workouts");
  }

  return data.data || [];
}

/**
 * Get detailed Peloton workout info
 * @param {string} session_id - Peloton session cookie
 * @param {string} workout_id - Workout ID
 * @returns {Promise<Object>} - Detailed workout data
 */
async function getPelotonWorkoutDetails(session_id, workout_id) {
  const resp = await fetch(
    `https://api.onepeloton.com/api/workout/${workout_id}`,
    {
      headers: {
        Cookie: `peloton_session_id=${session_id}`,
      },
    }
  );

  if (resp.status === 401) {
    const error = new Error("Peloton session expired");
    error.code = "SESSION_EXPIRED";
    throw error;
  }

  const data = await resp.json();

  if (!resp.ok) {
    throw new Error(data.message || "Failed to fetch Peloton workout details");
  }

  return data;
}

/**
 * Extract distance in miles from a Peloton workout
 * @param {Object} workout - Workout object from Peloton API
 * @returns {number|null} - Distance in miles, or null if no distance
 */
function extractPelotonDistance(workout) {
  // Peloton stores metrics in different places depending on workout type
  // Check overall_summary first, then summaries array
  const summary = workout.overall_summary || workout;

  // Distance is typically in miles for US users
  if (summary.distance !== undefined && summary.distance > 0) {
    return summary.distance;
  }

  // Some workouts have distance in summaries array
  if (workout.summaries) {
    const distanceSummary = workout.summaries.find(s => s.slug === "distance");
    if (distanceSummary && distanceSummary.value > 0) {
      return distanceSummary.value;
    }
  }

  return null;
}

/**
 * Get emoji for Peloton workout type
 * @param {string} fitness_discipline - Peloton fitness_discipline field
 * @returns {string} - Appropriate emoji
 */
function getWorkoutEmoji(fitness_discipline) {
  const emojiMap = {
    running: "🏃",
    outdoor_running: "🏃",
    walking: "🚶",
    outdoor_walking: "🚶",
    cycling: "🚴",
    outdoor_cycling: "🚴",
  };
  return emojiMap[fitness_discipline] || "🏃";
}

/**
 * Send session expiry notification to user via Slack DM
 */
async function notifySessionExpired(conn) {
  const baseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  const reauthUrl = `${baseUrl}/auth/peloton/start?slack_user_id=${conn.slack_user_id}`;

  const token = process.env.SLACK_BOT_TOKEN;
  const dmText = `Your Peloton session has expired. Your workouts are no longer being posted automatically.\n\n` +
    `Please re-authenticate to resume auto-posting:\n${reauthUrl}`;

  try {
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: conn.slack_user_id, text: dmText }),
    });
    console.log(`Sent session expiry notification to ${conn.slack_user_id}`);
  } catch (err) {
    console.error("Failed to send session expiry notification:", err);
  }
}

/**
 * Post a Peloton workout to Slack
 */
async function slackPostPelotonActivity(workout, conn) {
  const distance = extractPelotonDistance(workout);
  if (!distance) return null; // Skip workouts without distance

  const pedometerUserId = process.env.FETCH_PEDOMETER_USER_ID;
  const emoji = getWorkoutEmoji(workout.fitness_discipline);

  // Build workout title
  const title = workout.ride?.title || workout.title || "Peloton Workout";

  // Peloton workout URL
  const workoutUrl = `https://members.onepeloton.com/members/${conn.username}/workouts/${workout.id}`;

  const text =
    `<@${pedometerUserId}> +${distance.toFixed(2)} mile ${emoji}\n` +
    `<@${conn.slack_user_id}>: ${title}\n` +
    `${workoutUrl}`;

  return await slackPostMessage(text);
}

// ============================================================
// PELOTON AUTH ROUTES
// ============================================================

/**
 * Peloton login form
 * GET /auth/peloton/start?slack_user_id=U...
 */
app.get("/auth/peloton/start", async (req, res) => {
  const slackUserId = req.query.slack_user_id;

  if (!slackUserId) {
    return res.status(400).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Error</title></head>
      <body style="font-family: sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
        <h1>Missing Slack ID</h1>
        <p>Please start from the <a href="/">homepage</a> to connect Peloton.</p>
      </body>
      </html>
    `);
  }

  // Check if Slack user is verified
  const isVerified = await isSlackUserVerified(slackUserId);
  if (!isVerified) {
    return res.status(403).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Not Verified</title></head>
      <body style="font-family: sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
        <h1>Slack Not Verified</h1>
        <p>You must verify your Slack account before connecting Peloton.</p>
        <p>Please go to the <a href="/">homepage</a> and complete Step 1 first.</p>
      </body>
      </html>
    `);
  }

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Connect Peloton</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          max-width: 500px;
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
        label {
          display: block;
          margin-top: 15px;
          font-weight: bold;
        }
        input {
          width: 100%;
          padding: 10px;
          font-size: 16px;
          border: 2px solid #ddd;
          border-radius: 4px;
          box-sizing: border-box;
          margin-top: 5px;
        }
        button {
          background: #DF1C2F;
          color: white;
          padding: 12px 24px;
          font-size: 16px;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          width: 100%;
          margin-top: 20px;
        }
        button:hover { background: #b8182a; }
        .note {
          font-size: 12px;
          color: #666;
          margin-top: 10px;
        }
      </style>
    </head>
    <body>
      <h1>🚴 Connect Peloton</h1>
      <p>Enter your Peloton credentials to auto-post your workouts to Slack.</p>

      <div class="card">
        <form action="/auth/peloton/login" method="POST">
          <input type="hidden" name="slack_user_id" value="${slackUserId}" />
          <label for="username">Peloton Username or Email</label>
          <input type="text" id="username" name="username" required />
          <label for="password">Peloton Password</label>
          <input type="password" id="password" name="password" required />
          <button type="submit">Connect Peloton</button>
        </form>
        <p class="note">Your password is sent directly to Peloton and is never stored by this app.</p>
      </div>

      <a href="/">← Back to home</a>
    </body>
    </html>
  `);
});

/**
 * Handle Peloton login
 * POST /auth/peloton/login
 */
app.post("/auth/peloton/login", async (req, res) => {
  try {
    const { slack_user_id, username, password } = req.body;

    if (!slack_user_id || !username || !password) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Error</title></head>
        <body style="font-family: sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
          <h1>Missing Fields</h1>
          <p>Please fill in all fields.</p>
          <a href="/auth/peloton/start?slack_user_id=${slack_user_id}">← Try again</a>
        </body>
        </html>
      `);
    }

    // Verify Slack user is verified
    const isVerified = await isSlackUserVerified(slack_user_id);
    if (!isVerified) {
      return res.status(403).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Not Verified</title></head>
        <body style="font-family: sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
          <h1>Slack Not Verified</h1>
          <p>Your Slack account must be verified first.</p>
          <a href="/">← Go back to verify</a>
        </body>
        </html>
      `);
    }

    // Login to Peloton
    const { session_id, user_id } = await pelotonLogin(username, password);

    // Store connection (password is NOT stored)
    await upsertPelotonConnection({
      peloton_user_id: user_id,
      slack_user_id: slack_user_id,
      session_id: session_id,
      username: username.includes("@") ? username.split("@")[0] : username,
    });

    console.log(`Peloton connected: user_id=${user_id}, slack_user_id=${slack_user_id}`);

    res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>Connected!</title></head>
      <body style="font-family: sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
        <h1>✅ Peloton Connected!</h1>
        <p>Your Peloton account is now linked. Your workouts with distance (running, cycling, walking) will be automatically posted to Slack.</p>
        <p><strong>Peloton User ID:</strong> ${user_id}</p>
        <p><strong>Slack ID:</strong> ${slack_user_id}</p>
        <a href="/">← Back to home</a>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("Peloton login error:", err);
    const slackUserId = req.body.slack_user_id || "";
    res.status(400).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Login Failed</title></head>
      <body style="font-family: sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
        <h1>Peloton Login Failed</h1>
        <p>${err.message}</p>
        <p>Please check your username and password.</p>
        <a href="/auth/peloton/start?slack_user_id=${slackUserId}">← Try again</a>
      </body>
      </html>
    `);
  }
});

/**
 * List Peloton connections (admin)
 */
app.get("/peloton/connections", requireAdminAuth, async (req, res) => {
  const rows = await listPelotonConnections();
  res.json({ ok: true, connections: rows });
});

/**
 * Delete Peloton connection (admin)
 */
app.delete("/peloton/connections/:peloton_user_id", requireAdminAuth, async (req, res) => {
  try {
    await deletePelotonConnection(req.params.peloton_user_id);
    res.json({ ok: true, message: "Connection deleted" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================
// PELOTON POLLING LOOP
// ============================================================

/**
 * Poll a single Peloton user for new workouts
 */
async function pollPelotonUser(conn) {
  const result = { posted: 0, skipped: 0, errors: 0 };

  try {
    // Fetch recent workouts
    const workouts = await getPelotonWorkouts(conn.session_id, conn.peloton_user_id);

    for (const workoutSummary of workouts) {
      try {
        // Check idempotency
        if (await wasPelotonWorkoutPosted(workoutSummary.id)) {
          result.skipped++;
          continue;
        }

        // Get full workout details
        const workout = await getPelotonWorkoutDetails(conn.session_id, workoutSummary.id);

        // Check if workout has distance
        const distance = extractPelotonDistance(workout);
        if (!distance) {
          result.skipped++;
          continue;
        }

        // Post to Slack
        await slackPostPelotonActivity(workout, conn);

        // Mark as posted
        await markPelotonWorkoutPosted(workoutSummary.id, conn.slack_user_id);
        result.posted++;

        console.log(`Posted Peloton workout ${workoutSummary.id} for ${conn.slack_user_id}`);
      } catch (workoutErr) {
        console.error(`Error processing workout ${workoutSummary.id}:`, workoutErr);
        result.errors++;
      }
    }
  } catch (err) {
    if (err.code === "SESSION_EXPIRED") {
      console.log(`Peloton session expired for ${conn.slack_user_id}`);
      await notifySessionExpired(conn);
    } else {
      console.error(`Error polling Peloton user ${conn.peloton_user_id}:`, err);
    }
    result.errors++;
  }

  return result;
}

/**
 * Main Peloton polling function - polls all connected users
 */
async function pollAllPelotonUsers() {
  console.log("Starting Peloton poll cycle...");

  try {
    const connections = await listPelotonConnections();

    if (connections.length === 0) {
      console.log("No Peloton connections to poll");
      return;
    }

    let totalPosted = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    for (const conn of connections) {
      // Get full connection with session_id
      const fullConn = await getPelotonConnection(conn.peloton_user_id);
      if (!fullConn || !fullConn.session_id) {
        console.log(`Skipping ${conn.peloton_user_id} - no session`);
        continue;
      }

      const result = await pollPelotonUser(fullConn);
      totalPosted += result.posted;
      totalSkipped += result.skipped;
      totalErrors += result.errors;
    }

    console.log(`Peloton poll complete: posted=${totalPosted}, skipped=${totalSkipped}, errors=${totalErrors}`);
  } catch (err) {
    console.error("Peloton poll cycle error:", err);
  }
}

/**
 * Start the Peloton polling loop
 */
function startPelotonPoller() {
  const intervalMinutes = parseInt(process.env.PELOTON_POLL_INTERVAL_MINUTES) || 5;
  const intervalMs = intervalMinutes * 60 * 1000;

  console.log(`Starting Peloton poller with ${intervalMinutes} minute interval`);

  // Run immediately on startup
  pollAllPelotonUsers();

  // Then run on interval
  setInterval(pollAllPelotonUsers, intervalMs);
}

/**
 * DEBUG: Check your connection status (temporary endpoint)
 */
app.get("/debug/my-connection", async (req, res) => {
  try {
    const athleteId = 19826530; // Your athlete ID
    const conn = await getConnection(athleteId);

    if (!conn) {
      return res.json({ ok: false, error: "No connection found" });
    }

    res.json({
      ok: true,
      athlete_id: conn.athlete_id,
      athlete_name: `${conn.athlete_firstname} ${conn.athlete_lastname}`,
      slack_user_id: conn.slack_user_id,
      verified: conn.verified,
      has_verification_token: !!conn.verification_token,
      updated_at: conn.updated_at,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * Admin-ish: List who has connected
 */
app.get("/connections", requireAdminAuth, async (req, res) => {
  const rows = await listConnections();
  res.json({ ok: true, connections: rows });
});

/**
 * Update Slack user ID for a Strava athlete
 * POST /connections/:athlete_id/slack
 * Body: { "slack_user_id": "U04HBADQP0B" }
 */
app.post("/connections/:athlete_id/slack", requireAdminAuth, async (req, res) => {
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

    // Check if user has verified their Slack account
    if (conn.slack_user_id && !conn.verified) {
      console.log(`User ${athleteId} has not verified their Slack account yet. Skipping.`);
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

  // Start Peloton polling loop
  startPelotonPoller();
});