# Monad Tip Bot

A Telegram bot for sending and receiving MON tips on Monad Testnet. Built with Node.js, ethers.js, and PostgreSQL.

## Features

- 💰 Create funding and claim wallets
- 💸 Send MON tips to Telegram users
- 🔄 Automatic wallet management
- 📊 Balance tracking
- 🔐 Secure private key storage
- 💾 PostgreSQL database persistence
- 🌐 Monad Testnet support

## Architecture

The bot uses a dual-wallet system:
1. **Funding Wallet**: Your personal wallet to send tips from
2. **Claim Wallet**: Automatically created when you receive tips

## Fee Structure

- **Transaction Fee**: 10% of tip amount
- **Network Fee**: ~0.000005 MON per transaction

## Prerequisites

- Node.js 18.x or higher
- PostgreSQL database
- Telegram Bot Token
- Monad Testnet MON tokens

## Local Development Setup

1. **Clone the repository**
   ```bash
   cd /path/to/Tip\ Monad
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Create a Telegram Bot**
   - Open Telegram and search for @BotFather
   - Send `/newbot` and follow the instructions
   - Copy the bot token

4. **Set up environment variables**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and add:
   - `TELEGRAM_BOT_TOKEN`: Your bot token from BotFather
   - `DATABASE_URL`: Your PostgreSQL connection string

5. **Run the bot**
   ```bash
   npm start
   ```

   For development with auto-reload:
   ```bash
   npm run dev
   ```

## Railway Deployment Guide

### Step 1: Prepare Your Repository

1. Initialize git (if not already done):
   ```bash
   git init
   git add .
   git commit -m "Initial commit - Monad Tip Bot"
   ```

2. Push to GitHub:
   ```bash
   git remote add origin <your-github-repo-url>
   git push -u origin main
   ```

### Step 2: Deploy to Railway

1. **Sign up/Login to Railway**
   - Go to [railway.app](https://railway.app)
   - Sign in with GitHub

2. **Create a New Project**
   - Click "New Project"
   - Select "Deploy from GitHub repo"
   - Choose your repository

3. **Add PostgreSQL Database**
   - In your Railway project dashboard
   - Click "+ New"
   - Select "Database" → "PostgreSQL"
   - Railway will automatically provision a PostgreSQL database
   - The `DATABASE_URL` environment variable will be automatically set

4. **Configure Environment Variables**
   - Go to your service (the bot)
   - Click on "Variables" tab
   - Add the following variables:
     - `TELEGRAM_BOT_TOKEN`: Your bot token from BotFather
   - Note: `DATABASE_URL` is automatically provided by Railway PostgreSQL

5. **Deploy**
   - Railway will automatically deploy your bot
   - Check the deployment logs to ensure it's running
   - You should see "Monad Tip Bot is running..." in the logs

### Step 3: Configure Fee Wallet (IMPORTANT)

Before using the bot in production, update the `FEES_WALLET` address in `bot-monad.js`:

```javascript
const FEES_WALLET = 'YOUR_MONAD_WALLET_ADDRESS_HERE';
```

Replace the placeholder address with your actual Monad wallet address where you want to collect fees.

### Step 4: Test the Bot

1. Open Telegram and search for your bot
2. Send `/start` to initialize
3. Create a funding wallet
4. Fund it with Monad testnet tokens
5. Try tipping another user

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Create your funding wallet and see welcome message |
| `/help` | Show help message with all commands |
| `/balance` | Check your wallet balances |
| `/tip @username amount` | Send MON to another user |
| `/claim` | View and manage your received tips |
| `/tutorial` | Show the tutorial guide |

## Usage Examples

```
/tip @alice 1.5
/tip @bob 0.5
/balance
/claim
```

## Monad Testnet Information

- **Network**: Monad Testnet
- **RPC URL**: https://testnet.monad.xyz/
- **Chain ID**: Check Monad documentation
- **Explorer**: https://testnet.monad.xyz/

To get testnet MON tokens, check the Monad Discord or testnet faucet.

## Database Schema

The bot uses three main tables:

### user_wallets
Stores funding wallets for users
- `user_id` (PRIMARY KEY)
- `private_key`
- `public_key`
- `created_at`

### claim_wallets
Stores claim wallets for tip recipients
- `username` (PRIMARY KEY)
- `private_key`
- `public_key`
- `from_user_id`
- `amount`
- `created_at`

### tips
Transaction history
- `id` (PRIMARY KEY)
- `from_user_id`
- `to_username`
- `amount`
- `fee_amount`
- `transaction_signature`
- `created_at`

## Security Considerations

⚠️ **IMPORTANT SECURITY NOTES**:

1. **Private Keys**: Never share your private keys. The bot stores them encrypted in the database.
2. **Database Security**: Use Railway's PostgreSQL with SSL enabled (already configured).
3. **Environment Variables**: Never commit `.env` file to git.
4. **Bot Token**: Keep your Telegram bot token secret.
5. **Fee Wallet**: Update the fee wallet address before production use.

## Troubleshooting

### Bot not responding
- Check Railway logs for errors
- Verify `TELEGRAM_BOT_TOKEN` is set correctly
- Ensure database is connected

### Database connection errors
- Verify `DATABASE_URL` environment variable
- Check if PostgreSQL service is running on Railway
- Ensure SSL is enabled in connection string

### Transaction failures
- Check Monad testnet RPC is accessible
- Verify wallet has sufficient balance
- Ensure Monad testnet is operational

## Railway-Specific Tips

1. **Logs**: View real-time logs in Railway dashboard
2. **Scaling**: Railway auto-scales based on usage
3. **Database Backups**: Railway PostgreSQL includes automatic backups
4. **Custom Domains**: Can be configured in Railway settings
5. **Environment Variables**: Update anytime in Variables tab

## Maintenance

### Updating the Bot

1. Make changes to your code
2. Commit and push to GitHub:
   ```bash
   git add .
   git commit -m "Update bot features"
   git push
   ```
3. Railway will automatically redeploy

### Database Migrations

If you need to update the database schema:

1. Connect to Railway PostgreSQL using the provided credentials
2. Run SQL migrations manually or use a migration tool
3. Update the `initializeDatabase()` function in `bot-monad.js`

## Cost Estimates

### Railway Costs
- **Hobby Plan**: $5/month (includes $5 credit)
- **PostgreSQL**: Included in usage
- Estimated monthly cost: ~$5-10 depending on usage

### Monad Testnet
- **Testnet Tokens**: Free
- **Transaction Fees**: Minimal on testnet

## Contributing

Feel free to submit issues and enhancement requests!

## License

MIT License

## Support

For issues:
1. Check the troubleshooting section
2. Review Railway deployment logs
3. Verify Monad testnet status
4. Check environment variables configuration

## Changelog

### v1.0.0
- Initial release
- Monad testnet support
- Dual wallet system
- Railway deployment ready
- PostgreSQL persistence

---

**Built with ❤️ for the Monad community**

---

## Appendix: Monad Blitz Delhi Submission Process

1. Visit the `monad-blitz-delhi` repo (link [here](https://github.com/monad-developers/monad-blitz-delhi)) and fork it.

   <img width="1512" alt="Screenshot 2025-06-05 at 1 47 48 PM" src="https://github.com/user-attachments/assets/a837398a-cca4-42cf-b6ff-709b567c9aa9" />

2. Give it your project name, a one-liner description, make sure you are forking the `main` branch and click `Create Fork`.

   <img width="1512" alt="Screenshot 2025-06-05 at 1 48 10 PM" src="https://github.com/user-attachments/assets/62ea369a-de81-4460-8136-e3f9320abfb8" />

3. In your fork you can make all the changes you want—add code for your project, create branches, update the `README.md`; you can change anything and everything.
