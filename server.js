import express from "express";
import "dotenv/config";
import fetch from "node-fetch";
import polyline from "@mapbox/polyline";
import puppeteer from "puppeteer";
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
  listVerifiedSlackUsers,
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
// Parse JSON bodies (only for application/json content-type)
app.use(express.json({ type: "application/json" }));
// Parse URL-encoded bodies (for HTML form submissions)
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

// Shared CSS styles for consistent look across all pages
const sharedStyles = `
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    max-width: 680px;
    margin: 0 auto;
    padding: 40px 20px;
    line-height: 1.6;
    color: #1a1a2e;
    background: linear-gradient(135deg, #f5f7fa 0%, #e4e8ec 100%);
    min-height: 100vh;
  }
  .container {
    background: white;
    border-radius: 16px;
    padding: 40px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.08);
  }
  h1 {
    font-size: 2rem;
    font-weight: 700;
    margin: 0 0 8px 0;
    color: #1a1a2e;
  }
  .subtitle {
    color: #6b7280;
    font-size: 1.1rem;
    margin: 0 0 32px 0;
  }
  h2 {
    font-size: 1.25rem;
    font-weight: 600;
    margin: 0 0 12px 0;
    color: #1a1a2e;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .card {
    background: #fafafa;
    padding: 24px;
    border-radius: 12px;
    margin: 20px 0;
    border: 1px solid #e5e7eb;
    transition: transform 0.2s, box-shadow 0.2s;
  }
  .card:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0,0,0,0.05);
  }
  .card p { color: #6b7280; margin: 0 0 16px 0; font-size: 0.95rem; }
  .card.strava { border-left: 4px solid #FC4C02; }
  .card.peloton { border-left: 4px solid #DF1C2F; }
  .card.verify { border-left: 4px solid #3b82f6; background: #eff6ff; }
  input[type="text"], input[type="password"], input[type="email"] {
    width: 100%;
    padding: 14px 16px;
    font-size: 16px;
    border: 2px solid #e5e7eb;
    border-radius: 10px;
    transition: border-color 0.2s, box-shadow 0.2s;
    background: white;
  }
  input:focus {
    outline: none;
    border-color: #3b82f6;
    box-shadow: 0 0 0 3px rgba(59,130,246,0.1);
  }
  label {
    display: block;
    margin-bottom: 8px;
    font-weight: 600;
    font-size: 0.9rem;
    color: #374151;
  }
  button {
    color: white;
    padding: 14px 24px;
    font-size: 16px;
    font-weight: 600;
    border: none;
    border-radius: 10px;
    cursor: pointer;
    width: 100%;
    margin-top: 16px;
    transition: transform 0.2s, box-shadow 0.2s;
  }
  button:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  }
  button:active { transform: translateY(0); }
  .btn-verify { background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); }
  .btn-strava { background: linear-gradient(135deg, #FC4C02 0%, #e34402 100%); }
  .btn-peloton { background: linear-gradient(135deg, #DF1C2F 0%, #b8182a 100%); }
  .btn-back {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: #3b82f6;
    text-decoration: none;
    font-weight: 500;
    margin-top: 24px;
    font-size: 0.95rem;
  }
  .btn-back:hover { text-decoration: underline; }
  .instructions {
    background: #eff6ff;
    padding: 20px;
    border-radius: 12px;
    margin: 24px 0;
    border: 1px solid #bfdbfe;
  }
  .instructions strong { color: #1e40af; }
  .instructions ol { margin: 12px 0; padding-left: 20px; color: #374151; }
  .instructions li { margin: 6px 0; }
  code {
    background: #1e293b;
    color: #e2e8f0;
    padding: 3px 8px;
    border-radius: 6px;
    font-family: "SF Mono", Monaco, monospace;
    font-size: 0.9em;
  }
  .step-badge {
    background: #1a1a2e;
    color: white;
    border-radius: 8px;
    min-width: 28px;
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 0.85rem;
    font-weight: 700;
  }
  .note {
    font-size: 0.85rem;
    color: #6b7280;
    margin-top: 12px;
    padding-left: 12px;
    border-left: 2px solid #e5e7eb;
  }
  .divider {
    height: 1px;
    background: linear-gradient(90deg, transparent, #e5e7eb, transparent);
    margin: 32px 0;
  }
  .section-label {
    text-transform: uppercase;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    color: #9ca3af;
    margin-bottom: 16px;
  }
`;

app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <title>Fitness to Slack</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta charset="utf-8">
      <style>${sharedStyles}</style>
    </head>
    <body>
      <div class="container">
        <h1>Fitness to Slack</h1>
        <p class="subtitle">Automatically share your workouts with your team</p>

        <div class="instructions">
          <strong>First, find your Slack Member ID:</strong>
          <ol>
            <li>Open Slack and click your profile picture</li>
            <li>Click <strong>Profile</strong></li>
            <li>Click the <strong>⋯</strong> menu → <strong>Copy member ID</strong></li>
          </ol>
          <p style="margin:12px 0 0 0;color:#374151;">It looks like: <code>U04HBADQP0B</code></p>
        </div>

        <div class="section-label">Step 1</div>
        <div class="card verify">
          <h2><span class="step-badge">1</span> Verify Your Slack</h2>
          <p>We'll send a verification link to your Slack DMs.</p>
          <form id="verifyForm" action="/verify/slack/start" method="POST">
            <label for="verifySlackId">Slack Member ID</label>
            <input type="text" id="verifySlackId" name="slack_user_id" placeholder="U04HBADQP0B" pattern="U[A-Za-z0-9]{8,}" required />
            <button type="submit" class="btn-verify">Send Verification Link</button>
          </form>
        </div>

        <div class="divider"></div>
        <div class="section-label">Step 2 — Connect a service</div>

        <div class="card strava">
          <h2><span class="step-badge">2a</span> Connect Strava</h2>
          <p>Auto-post your runs to Slack in real-time.</p>
          <form id="stravaForm">
            <label for="stravaSlackId">Slack Member ID</label>
            <input type="text" id="stravaSlackId" name="slackId" placeholder="U04HBADQP0B" pattern="U[A-Za-z0-9]{8,}" required />
            <button type="submit" class="btn-strava">Connect Strava</button>
          </form>
        </div>

        <div class="card peloton">
          <h2><span class="step-badge">2b</span> Connect Peloton</h2>
          <p>Auto-post cycling, running, and walking workouts.</p>
          <form id="pelotonForm">
            <label for="pelotonSlackId">Slack Member ID</label>
            <input type="text" id="pelotonSlackId" name="slackId" placeholder="U04HBADQP0B" pattern="U[A-Za-z0-9]{8,}" required />
            <button type="submit" class="btn-peloton">Connect Peloton</button>
          </form>
          <p class="note">Your Peloton password is sent directly to Peloton and never stored.</p>
        </div>
      </div>

      <script>
        document.getElementById('stravaForm').addEventListener('submit', (e) => {
          e.preventDefault();
          const slackId = document.getElementById('stravaSlackId').value.trim();
          if (slackId) window.location.href = '/auth/strava/start?slack_user_id=' + encodeURIComponent(slackId);
        });
        document.getElementById('pelotonForm').addEventListener('submit', (e) => {
          e.preventDefault();
          const slackId = document.getElementById('pelotonSlackId').value.trim();
          if (slackId) window.location.href = '/auth/peloton/start?slack_user_id=' + encodeURIComponent(slackId);
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
    let tokenData;
    try {
      tokenData = JSON.parse(raw);
    } catch {
      tokenData = { raw };
    }

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

    if (!slackUserId || !slackUserId.match(/^U[A-Za-z0-9]{8,}$/)) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head><title>Invalid Slack ID</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>${sharedStyles}</style></head>
        <body>
          <div class="container" style="text-align:center;">
            <div style="font-size:3rem;margin-bottom:16px;">⚠️</div>
            <h1>Invalid Slack ID</h1>
            <p class="subtitle">Please enter a valid Slack Member ID<br>(starts with U followed by letters/numbers).</p>
            <a href="/" class="btn-back">← Go back</a>
          </div>
        </body>
        </html>
      `);
    }

    // Check if already verified
    const existing = await getVerifiedSlackUser(slackUserId);
    if (existing?.verified) {
      return res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head><title>Already Verified</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>${sharedStyles}</style></head>
        <body>
          <div class="container" style="text-align:center;">
            <div style="font-size:4rem;margin-bottom:16px;">✅</div>
            <h1>Already Verified!</h1>
            <p class="subtitle">Your Slack account is already verified.<br>You can now connect Strava or Peloton.</p>
            <a href="/" class="btn-back">← Connect your services</a>
          </div>
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
        <html lang="en">
        <head><title>Error</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>${sharedStyles}</style></head>
        <body>
          <div class="container" style="text-align:center;">
            <div style="font-size:3rem;margin-bottom:16px;">❌</div>
            <h1>Couldn't Send DM</h1>
            <p class="subtitle">We couldn't send a DM to that Slack ID.<br>Please check the ID is correct.</p>
            <p style="background:#fef2f2;color:#991b1b;padding:12px;border-radius:8px;font-size:0.9rem;">Error: ${dmData.error}</p>
            <a href="/" class="btn-back">← Go back</a>
          </div>
        </body>
        </html>
      `);
    }

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head><title>Check Your Slack DMs</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>${sharedStyles}</style></head>
      <body>
        <div class="container" style="text-align:center;">
          <div style="font-size:4rem;margin-bottom:16px;">📬</div>
          <h1>Check Your Slack DMs!</h1>
          <p class="subtitle">We've sent a verification link to your Slack direct messages.</p>
          <p style="color:#374151;">Click the link in that message to verify your account, then come back here to connect Strava or Peloton.</p>
          <a href="/" class="btn-back">← Back to home</a>
        </div>
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
      return res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head><title>Link Already Used</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>${sharedStyles}</style></head>
        <body>
          <div class="container" style="text-align:center;">
            <div style="font-size:4rem;margin-bottom:16px;">🔗</div>
            <h1>Link Already Used</h1>
            <p class="subtitle">This verification link has already been used.</p>
            <p style="color:#374151;"><strong>Already verified?</strong> You're all set! Go ahead and connect your fitness services.</p>
            <a href="/" style="display:inline-block;margin-top:20px;padding:14px 28px;background:linear-gradient(135deg,#3b82f6,#2563eb);color:white;text-decoration:none;border-radius:10px;font-weight:600;">Connect Strava or Peloton</a>
          </div>
        </body>
        </html>
      `);
    }

    // Verify the user
    await verifySlackUserStandalone(token);

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head><title>Verified!</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>${sharedStyles}</style></head>
      <body>
        <div class="container" style="text-align:center;">
          <div style="font-size:4rem;margin-bottom:16px;">🎉</div>
          <h1>You're Verified!</h1>
          <p class="subtitle">Your Slack account is now verified.</p>
          <p style="color:#374151;">You can now connect Strava or Peloton to auto-post your workouts.</p>
          <a href="/" style="display:inline-block;margin-top:20px;padding:14px 28px;background:linear-gradient(135deg,#3b82f6,#2563eb);color:white;text-decoration:none;border-radius:10px;font-weight:600;">Connect Your Services</a>
        </div>
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
 * Login to Peloton using headless browser to bypass Cloudflare
 * @param {string} username - Peloton username or email
 * @param {string} password - Peloton password (never stored)
 * @returns {Promise<{session_id: string, user_id: string}>}
 */
async function pelotonLogin(username, password) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    await page.goto('https://auth.onepeloton.com/', { waitUntil: 'networkidle2' });

    await page.waitForSelector('input[name="usernameOrEmail"]', { timeout: 15000 });
    await page.type('input[name="usernameOrEmail"]', username, { delay: 50 });
    await page.type('input[name="password"]', password, { delay: 50 });

    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
    ]);

    await page.waitForFunction(
      () => document.cookie.includes('peloton_session_id'),
      { timeout: 15000 }
    ).catch(() => {});

    const cookies = await page.cookies();
    const sessionCookie = cookies.find(c => c.name === 'peloton_session_id');

    if (!sessionCookie) {
      const errorText = await page.evaluate(() => {
        const errorEl = document.querySelector('[class*="error"], [class*="Error"], .alert, .message');
        return errorEl ? errorEl.textContent : null;
      });
      throw new Error(errorText || 'Login failed - could not get session. Check username/password.');
    }

    const session_id = sessionCookie.value;

    const userResp = await page.evaluate(async (sid) => {
      const res = await fetch('https://api.onepeloton.com/api/me', {
        headers: { Cookie: `peloton_session_id=${sid}` },
        credentials: 'include',
      });
      return res.json();
    }, session_id);

    if (!userResp.id) {
      throw new Error('Could not fetch user ID after login');
    }

    return {
      session_id,
      user_id: userResp.id,
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
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
      <head>
        <title>Error</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>${sharedStyles}</style>
      </head>
      <body>
        <div class="container">
          <h1>Missing Slack ID</h1>
          <p class="subtitle">We couldn't find your Slack ID.</p>
          <div class="card">
            <p>Please start from the homepage to connect Peloton.</p>
          </div>
          <a href="/" class="btn-back">← Back to homepage</a>
        </div>
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
      <head>
        <title>Not Verified</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>${sharedStyles}</style>
      </head>
      <body>
        <div class="container">
          <h1>Slack Not Verified</h1>
          <p class="subtitle">One more step before connecting Peloton.</p>
          <div class="card verify">
            <p>You must verify your Slack account before connecting Peloton.</p>
            <p>Please complete <strong>Step 1</strong> on the homepage first.</p>
          </div>
          <a href="/" class="btn-back">← Back to homepage</a>
        </div>
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
      <style>${sharedStyles}</style>
    </head>
    <body>
      <div class="container">
        <h1>Connect Peloton</h1>
        <p class="subtitle">Enter your credentials to auto-post workouts to Slack.</p>

        <div class="card peloton">
          <h2><span class="step-badge">🚴</span> Peloton Login</h2>
          <p>Connect your Peloton account to automatically share your workouts.</p>
          <form action="/auth/peloton/login" method="POST">
            <input type="hidden" name="slack_user_id" value="${slackUserId}" />
            <div style="margin-bottom: 16px;">
              <label for="username">Peloton Username or Email</label>
              <input type="text" id="username" name="username" required placeholder="your@email.com" />
            </div>
            <div>
              <label for="password">Peloton Password</label>
              <input type="password" id="password" name="password" required placeholder="••••••••" />
            </div>
            <button type="submit" class="btn-peloton">Connect Peloton</button>
          </form>
          <p class="note">Your password is sent directly to Peloton and is never stored by this app.</p>
        </div>

        <a href="/" class="btn-back">← Back to home</a>
      </div>
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
        <head>
          <title>Error</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>${sharedStyles}</style>
        </head>
        <body>
          <div class="container">
            <h1>Missing Fields</h1>
            <p class="subtitle">Please fill in all required fields.</p>
            <div class="card">
              <p>Both username and password are required to connect your Peloton account.</p>
            </div>
            <a href="/auth/peloton/start?slack_user_id=${slack_user_id}" class="btn-back">← Try again</a>
          </div>
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
        <head>
          <title>Not Verified</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>${sharedStyles}</style>
        </head>
        <body>
          <div class="container">
            <h1>Slack Not Verified</h1>
            <p class="subtitle">One more step needed.</p>
            <div class="card verify">
              <p>Your Slack account must be verified before connecting Peloton.</p>
              <p>Please complete Step 1 on the homepage first.</p>
            </div>
            <a href="/" class="btn-back">← Back to verify</a>
          </div>
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
      <head>
        <title>Connected!</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>${sharedStyles}
          .success-icon {
            font-size: 4rem;
            margin-bottom: 16px;
          }
          .details {
            background: #f0fdf4;
            border: 1px solid #bbf7d0;
            border-radius: 10px;
            padding: 16px;
            margin: 20px 0;
          }
          .details p { margin: 8px 0; color: #166534; }
        </style>
      </head>
      <body>
        <div class="container" style="text-align: center;">
          <div class="success-icon">✅</div>
          <h1>Peloton Connected!</h1>
          <p class="subtitle">Your account is now linked and ready to go.</p>
          <div class="details">
            <p><strong>Peloton User ID:</strong> ${user_id}</p>
            <p><strong>Slack ID:</strong> ${slack_user_id}</p>
          </div>
          <p style="color: #6b7280;">Your workouts with distance (running, cycling, walking) will be automatically posted to Slack.</p>
          <a href="/" class="btn-back">← Back to home</a>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("Peloton login error:", err);
    const slackUserId = req.body.slack_user_id || "";
    res.status(400).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Login Failed</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>${sharedStyles}
          .error-box {
            background: #fef2f2;
            border: 1px solid #fecaca;
            border-radius: 10px;
            padding: 16px;
            margin: 20px 0;
            color: #991b1b;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Peloton Login Failed</h1>
          <p class="subtitle">We couldn't connect to your Peloton account.</p>
          <div class="error-box">
            <p><strong>Error:</strong> ${err.message}</p>
          </div>
          <div class="card">
            <p>Please check your username and password and try again.</p>
            <p class="note">If you use two-factor authentication, make sure to include the code.</p>
          </div>
          <a href="/auth/peloton/start?slack_user_id=${slackUserId}" class="btn-back">← Try again</a>
        </div>
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
      } catch (workoutErr) {
        console.error(`Error processing workout ${workoutSummary.id}:`, workoutErr);
        result.errors++;
      }
    }
  } catch (err) {
    if (err.code === "SESSION_EXPIRED") {
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
  try {
    const connections = await listPelotonConnections();
    if (connections.length === 0) return;

    for (const conn of connections) {
      const fullConn = await getPelotonConnection(conn.peloton_user_id);
      if (!fullConn || !fullConn.session_id) continue;
      await pollPelotonUser(fullConn);
    }
  } catch (err) {
    console.error("Peloton poll error:", err);
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
 * DEBUG: Check verified slack users table
 */
app.get("/debug/verified-users", async (req, res) => {
  try {
    const users = await listVerifiedSlackUsers();
    res.json({ ok: true, count: users.length, users });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

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
 * List all verified Slack users (admin)
 */
app.get("/verified-users", requireAdminAuth, async (req, res) => {
  const rows = await listVerifiedSlackUsers();
  res.json({ ok: true, verified_users: rows });
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

    // Only care about newly created activities
    if (event?.object_type !== "activity" || event?.aspect_type !== "create") return;

    const activityId = event.object_id;
    const athleteId = event.owner_id;

    // Idempotency: don't double-post
    if (await wasActivityPosted(activityId)) return;

    const conn = await getConnection(athleteId);
    if (!conn) return;

    // Check if user has verified their Slack account
    if (conn.slack_user_id && !conn.verified) return;

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

    // Only runs
    if (activity.type !== "Run") return;

    // Post activity with map image (or without if no map available)
    await slackPostActivityWithMap(activity, conn);
    await markActivityPosted(activityId, athleteId);
  } catch (err) {
    console.error("Webhook error:", err);
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error(`Error on ${req.method} ${req.path}:`, err.message);
  res.status(500).send(`Error: ${err.message}`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);

  // Start Peloton polling loop
  startPelotonPoller();
});