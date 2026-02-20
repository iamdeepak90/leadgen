# 🚀 LeadGen Engine

Automated lead generation system that finds local businesses without websites, sends AI-personalized pitches, and manages follow-ups.

## ✨ Features

- 🔍 **Automated Scanning** - Finds businesses via Google Places API
- 🤖 **AI-Powered Pitches** - Personalized emails & WhatsApp messages using OpenRouter
- 📧 **Multi-Channel Outreach** - SendGrid email + Twilio WhatsApp
- 🔄 **Smart Follow-ups** - 3-stage follow-up sequence (Day 3, 5, 7)
- 💬 **Reply Detection** - Instant Slack alerts when leads respond
- 📊 **Admin Panel** - Web UI for configuration and monitoring
- 🗄️ **PostgreSQL + Redis** - Production-grade data storage and job queues

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- PostgreSQL
- Redis

### Installation
```bash
# Clone the repo
git clone https://github.com/YOUR-USERNAME/leadgen-engine.git
cd leadgen-engine

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env and add your API keys

# Run database migration
node src/db/migrate.js

# Start the server
npm start
```

Visit http://localhost:3001/admin to configure.

## 📚 Documentation

See [README.md](README.md) in the repo for complete setup instructions.

## 🔑 API Keys Needed

- Google Places API
- OpenRouter API
- SendGrid API
- Slack Webhook (for notifications)
- Twilio (optional - for WhatsApp)

## 🛠️ Tech Stack

- **Backend**: Node.js, Express
- **Database**: PostgreSQL
- **Queue**: Bull + Redis
- **AI**: OpenRouter (Claude, GPT-4, etc.)
- **Email**: SendGrid
- **WhatsApp**: Twilio

## 📄 License

Private - Not for redistribution

---

Built with ❤️ for automated lead generation
