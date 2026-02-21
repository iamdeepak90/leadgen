# ⚡ LeadGen System — Gadgeek

Automated lead generation system that finds local businesses without working websites and pitches them via Email, WhatsApp, and SMS.

---

## 🏗 Architecture

```
Node.js (Express) + PostgreSQL + Redis (Bull queues)
├── Google Places API     → Scan for businesses without websites
├── OpenRouter API        → AI-generated personalized pitches
├── SendGrid              → Email outreach
├── WaSenderAPI           → WhatsApp outreach (primary)
├── Twilio                → SMS fallback when WhatsApp fails
└── Slack                 → Notifications & morning briefings
```

---

## 🚀 Deployment on Coolify (Git-based)

### Step 1: Push to Git

```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/yourusername/leadgen.git
git push -u origin main
```

### Step 2: Create Services in Coolify

You need **3 services**:

**A) PostgreSQL**
- Go to Coolify → New Resource → Database → PostgreSQL
- Note the `DATABASE_URL` it gives you

**B) Redis**
- Go to Coolify → New Resource → Database → Redis
- Note the `REDIS_URL` it gives you

**C) Node.js App**
- Go to Coolify → New Resource → Application
- Connect your Git repo
- Set **Build Command**: `npm install`
- Set **Start Command**: `npm start`
- Set **Port**: `3000`

### Step 3: Environment Variables (only 2 needed!)

In Coolify app settings → Environment Variables:
```
DATABASE_URL=postgresql://user:password@host:5432/dbname
REDIS_URL=redis://host:6379
```

That's it. Everything else is configured via the admin panel.

### Step 4: Run Database Migration

In Coolify, open the terminal for your app and run:
```bash
npm run migrate
```

Or add it to the build command: `npm install && npm run migrate`

### Step 5: Access Admin Panel

- URL: `https://lead.gadgeek.in/admin`
- Email: `lead@gadgeek.in`
- Password: `HelloGG@$44`

### Step 6: Configure via Admin Panel

1. **API Keys** → Enter Google Places, OpenRouter, SendGrid, Twilio, WaSender, Slack keys
2. **Email Config** → Set your from email and name
3. **Scan Config** → Add your target cities and business categories
4. **Automation** → Enable the toggles you want
5. **Prompts** → Customize AI prompts to match your voice

---

## 📋 File Structure

```
├── package.json
├── src/
│   ├── server.js              ← Entry point
│   ├── config/index.js        ← Settings loader
│   ├── db/
│   │   ├── migrate.js         ← Run once to create tables
│   │   └── index.js           ← All DB queries
│   ├── scanner/index.js       ← Google Places + website checker
│   ├── pitcher/index.js       ← OpenRouter AI pitch generation
│   ├── outreach/index.js      ← SendGrid, WaSender, Twilio
│   ├── queues/index.js        ← Bull queue workers
│   ├── jobs/index.js          ← Cron schedulers
│   ├── notifications/index.js ← Slack + email briefings
│   ├── api/routes.js          ← REST API + webhooks
│   ├── admin/index.html       ← Complete admin SPA
│   └── utils/logger.js        ← Winston logger
└── README.md
```

---

## 🔗 Webhook Setup

### SendGrid Inbound Parse (for email reply detection)

1. Go to [SendGrid Inbound Parse](https://app.sendgrid.com/settings/parse)
2. Add a hostname, e.g. `inbound.yourdomain.com`
3. Set MX records for that domain pointing to `mx.sendgrid.net`
4. Set the POST URL to: `https://lead.gadgeek.in/api/webhooks/sendgrid`
5. Check "POST the raw, full MIME message"

All emails sent to `*@inbound.yourdomain.com` will be parsed and matched to leads.

### Twilio SMS Webhook (for SMS reply detection)

1. Go to [Twilio Console](https://console.twilio.com) → Phone Numbers → Your Number
2. Under "Messaging" → "A message comes in"
3. Set to: `https://lead.gadgeek.in/api/webhooks/twilio`
4. Method: `HTTP POST`

### WaSenderAPI Setup

1. Go to [wasenderapi.com](https://wasenderapi.com) and create an account
2. Connect your WhatsApp number by scanning the QR code
3. Copy your API key and paste in admin Settings → API Keys
4. ⚠️ WhatsApp number stays connected as long as your phone has internet
5. If disconnected, reconnect via WaSenderAPI dashboard

---

## 🤖 How the Lead Pipeline Works

```
1. SCAN (2 AM IST daily or manual)
   Google Places searches each city × category combination
   → Checks website status (none / dead / parked)
   → Saves new businesses as leads

2. PITCH (9 AM IST daily or manual)
   Batches up to 50 new leads
   → AI generates email + WhatsApp/SMS pitch
   → Email sent via SendGrid
   → WhatsApp tried via WaSenderAPI, falls back to SMS (Twilio)
   → Follow-ups scheduled in Redis for Day 3, 5, 7

3. FOLLOW-UPS (AI-generated fresh each time)
   Day 3: Friendly check-in, zero pressure
   Day 5: Competitor social proof angle
   Day 7: Final message + bonus offer
   → After Day 7 + 48h grace = auto-archived

4. REPLY DETECTION
   → Email replies caught by SendGrid webhook
   → SMS replies caught by Twilio webhook
   → On reply: cancel pending follow-ups → Slack alert
```

---

## 🔍 Website Status Detection

| Status | What it means | How detected |
|--------|--------------|--------------|
| `none` | Business has no website field on GMB | Google Places returns no website URL |
| `dead` | Website exists but is unreachable | HTTP timeout, DNS failure, 4xx/5xx errors |
| `parked` | Website is a placeholder/for-sale page | Body contains parking page patterns |

All three types are captured as leads (shown with distinct badges in admin).

---

## 💡 Tips

- **Start small**: Add 2-3 cities and 3-4 categories to test before scaling
- **API costs**: Google Places charges ~$0.017/place detail call. With `scan_only_new=true`, cost drops dramatically after first run
- **WhatsApp numbers**: WaSenderAPI works with personal WhatsApp — don't send bulk unsolicited messages or the number may be flagged
- **Prompts**: The default prompts are solid but customizing them to your specific voice/offer dramatically improves reply rates
- **Follow-up strategy**: Day 3 = soft, Day 5 = social proof, Day 7 = final + free offer is a proven sequence

---

## 🛠 API Reference

```
GET    /api/dashboard              → Stats + activity
GET    /api/leads                  → List leads (filterable)
GET    /api/leads/:id              → Lead detail + messages + replies
POST   /api/leads/:id/pitch        → Manually trigger pitch
POST   /api/leads/:id/convert      → Mark converted (body: {revenue})
POST   /api/leads/:id/archive      → Archive lead
PATCH  /api/leads/:id/notes        → Update notes (body: {notes})
GET    /api/settings               → Get all settings (keys masked)
PATCH  /api/settings               → Update settings
POST   /api/settings/test/:service → Test connection (services: google_places, openrouter, sendgrid, twilio, wasender, slack)
GET    /api/activity               → Activity feed
GET    /api/scans                  → Scan history
POST   /api/actions/scan           → Trigger manual scan
POST   /api/actions/pitch-batch    → Trigger manual pitch batch
POST   /api/webhooks/sendgrid      → SendGrid inbound parse (public)
POST   /api/webhooks/twilio        → Twilio SMS webhook (public)
GET    /health                     → Health check (public)
```

---

## 📦 Dependencies

| Package | Purpose |
|---------|---------|
| express | HTTP server |
| pg | PostgreSQL client |
| bull | Redis job queues |
| ioredis | Redis client |
| axios | HTTP requests (API calls) |
| node-cron | Cron job scheduling |
| winston | Logging |
| express-basic-auth | Admin panel auth |
| dayjs | Date manipulation |
| dotenv | .env loading |
