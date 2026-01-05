# Strava to Slack

Automatically post Strava running activities to Slack with @fetch-pedometer integration.

## Features

- 🏃 Auto-posts runs to Slack when completed
- 🔔 Mentions @fetch-pedometer for mileage tracking
- 👤 Mentions the runner in each post
- 🔗 Includes Strava activity link
- 👥 Multi-user support with self-service OAuth setup

## Deployment

### Render (Recommended)

1. Fork/clone this repo
2. Sign up at [render.com](https://render.com)
3. Create a new Web Service
4. Connect your GitHub repo
5. Configure environment variables (see `.env.example`)
6. Deploy!

### Environment Variables

Required variables (see `.env.example` for details):
- `SLACK_BOT_TOKEN`
- `SLACK_CHANNEL_ID`
- `FETCH_PEDOMETER_USER_ID`
- `STRAVA_CLIENT_ID`
- `STRAVA_CLIENT_SECRET`
- `STRAVA_REDIRECT_URI`
- `STRAVA_VERIFY_TOKEN`
- `PUBLIC_BASE_URL`

## Setup

1. Visit your deployed URL (e.g., `https://your-app.onrender.com`)
2. Follow instructions to get your Slack member ID
3. Connect your Strava account
4. Done! Your runs will now auto-post to Slack

## Local Development

```bash
npm install
cp .env.example .env
# Fill in your .env values
npm start
```

## License

ISC
