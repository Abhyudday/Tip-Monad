// Monad Testnet Tip Bot
// Environment variables will be provided by Railway

const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const { Pool } = require('pg');

// Initialize bot with token from environment variable
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Connect to Monad testnet
const provider = new ethers.JsonRpcProvider('https://testnet-rpc.monad.xyz/');

// Initialize PostgreSQL connection with environment variable
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Initialize maps for in-memory caching
let userWallets = new Map();
let claimWallets = new Map();

// Add fees wallet address constant - Replace with your actual Monad address
const FEES_WALLET = '0x0000000000000000000000000000000000000000'; // TODO: Replace with actual fee wallet
const FEE_PERCENTAGE = 0.10; // 10% fee per transaction
const NETWORK_FEE = 0.000005; // ~0.000005 MON per transaction

// Create tables if they don't exist
async function initializeDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_wallets (
                user_id TEXT PRIMARY KEY,
                private_key TEXT NOT NULL,
                public_key TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE TABLE IF NOT EXISTS claim_wallets (
                username TEXT PRIMARY KEY,
                private_key TEXT NOT NULL,
                public_key TEXT NOT NULL,
                from_user_id TEXT,
                amount DECIMAL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS tips (
                id SERIAL PRIMARY KEY,
                from_user_id TEXT NOT NULL,
                to_username TEXT NOT NULL,
                amount DECIMAL NOT NULL,
                fee_amount DECIMAL NOT NULL,
                transaction_signature TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('Database initialized successfully');
    } catch (error) {
        console.error('Error initializing database:', error);
    }
}

// Load wallets from database
async function loadWallets() {
    try {
        // Load user wallets
        const userWalletsResult = await pool.query('SELECT * FROM user_wallets');
        userWalletsResult.rows.forEach(row => {
            userWallets.set(row.user_id, {
                privateKey: row.private_key,
                publicKey: row.public_key
            });
        });

        // Load claim wallets
        const claimWalletsResult = await pool.query('SELECT * FROM claim_wallets');
        claimWalletsResult.rows.forEach(row => {
            claimWallets.set(row.username, {
                privateKey: row.private_key,
                publicKey: row.public_key,
                fromUserId: row.from_user_id,
                amount: parseFloat(row.amount) || 0
            });
        });
        console.log('Wallets loaded successfully from database');
    } catch (error) {
        console.error('Error loading wallets:', error);
    }
}

// Save wallet to database
async function saveWallet(userId, wallet, isClaimWallet = false) {
    try {
        if (isClaimWallet) {
            await pool.query(
                'INSERT INTO claim_wallets (username, private_key, public_key, from_user_id, amount) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (username) DO UPDATE SET private_key = $2, public_key = $3, from_user_id = $4, amount = $5',
                [userId, wallet.privateKey, wallet.publicKey, wallet.fromUserId, wallet.amount]
            );
        } else {
            await pool.query(
                'INSERT INTO user_wallets (user_id, private_key, public_key) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET private_key = $2, public_key = $3',
                [userId, wallet.privateKey, wallet.publicKey]
            );
        }
    } catch (error) {
        console.error('Error saving wallet:', error);
    }
}

// Initialize database and load wallets on startup
initializeDatabase().then(() => {
    loadWallets();
});

// Function to get wallet balance
async function getWalletBalance(address) {
    try {
        const balance = await provider.getBalance(address);
        return parseFloat(ethers.formatEther(balance));
    } catch (error) {
        console.error('Error getting balance:', error);
        return 0;
    }
}

// Function to create wallet from private key
function createWalletFromPrivateKey(privateKey) {
    return new ethers.Wallet(privateKey, provider);
}

// Welcome message with tutorial
const welcomeMessage = `🎉 *Welcome to Monad Tip Bot!* 🎉

This bot helps you send and receive MON tips on Monad Testnet.

*Network:* Monad Testnet
*Fee Structure:*
• Transaction Fee: 10% of tip amount
• Network Fee: ~0.000005 MON per transaction

Use the buttons below to get started!`;

// Help message
const helpMessage = `*Monad Tip Bot Commands* 📚

/start - Create your funding wallet
/tip @username amount - Send MON to someone
/claim - Claim your received tips
/help - Show this help message
/balance - Check your wallet balance
/tutorial - Show the tutorial again

*Examples:*
• /tip @john 0.5
• /tip @alice 1.2

*Fee Structure:*
• Transaction Fee: 10% of tip amount
• Network Fee: ~0.000005 MON per transaction

*Tips:*
• Always verify the username
• Check your balance before sending
• Keep your private keys safe
• Ensure you have enough MON for tip + fees`;

// Add helper function for transaction links
function getTransactionLink(signature) {
    return `https://testnet.monad.xyz/tx/${signature}`;
}

// Add helper function for transaction status check
async function checkTransactionStatus(txHash, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const receipt = await provider.getTransactionReceipt(txHash);
            if (receipt && receipt.status === 1) {
                return true;
            }
            // Wait for 2 seconds before next retry
            await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
            console.error(`Error checking transaction status (attempt ${i + 1}):`, error);
        }
    }
    return false;
}

// Handle /start command
bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username ? msg.from.username.toLowerCase() : null;
    const startParam = match[1]; // Get the start parameter if any
    
    // Send welcome message with buttons
    const keyboard = {
        inline_keyboard: [
            [{ text: "💰 Create/View Wallet", callback_data: "create_wallet" }],
            [{ text: "💸 Transfer All to Funding Wallet", callback_data: username ? `transfer_all_${username}` : "no_username" }],
            [{ text: "❓ Help", callback_data: "help" }]
        ]
    };
    
    await bot.sendMessage(chatId, welcomeMessage, { 
        parse_mode: 'Markdown',
        reply_markup: keyboard
    });
});

// Store withdrawal state
const withdrawalState = new Map();

// Handle callback queries
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const userId = callbackQuery.from.id;
    const data = callbackQuery.data;

    // Handle no username case
    if (data === "no_username") {
        await bot.sendMessage(chatId, "❌ Please set a username in your Telegram profile to use this feature.");
        return;
    }

    // Handle claim wallet actions
    if (data.startsWith('withdraw_claim_')) {
        const username = data.replace('withdraw_claim_', '');
        const claimWallet = claimWallets.get(username);
        
        if (!claimWallet) {
            await bot.sendMessage(chatId, "❌ No claim wallet found.");
            return;
        }

        // Set withdrawal state
        withdrawalState.set(userId, {
            type: 'claim',
            username: username,
            claimWallet: claimWallet
        });

        await bot.sendMessage(chatId, "💸 *Withdraw from Claim Wallet*\n\nPlease enter the Monad address where you want to withdraw your funds:", {
            parse_mode: 'Markdown'
        });
        return;
    }

    if (data.startsWith('withdraw_funding_')) {
        const userIdStr = userId.toString();
        const userWallet = userWallets.get(userIdStr);
        
        if (!userWallet) {
            await bot.sendMessage(chatId, "❌ No funding wallet found.");
            return;
        }

        // Set withdrawal state
        withdrawalState.set(userId, {
            type: 'funding',
            userWallet: userWallet
        });

        await bot.sendMessage(chatId, "💸 *Withdraw from Funding Wallet*\n\nPlease enter the Monad address where you want to withdraw your funds:", {
            parse_mode: 'Markdown'
        });
        return;
    }

    if (data.startsWith('transfer_all_')) {
        const username = data.replace('transfer_all_', '');
        const claimWallet = claimWallets.get(username);
        
        if (!claimWallet) {
            await bot.sendMessage(chatId, "❌ You don't have any tips to claim yet.");
            return;
        }

        const balance = await getWalletBalance(claimWallet.publicKey);
        
        if (balance <= NETWORK_FEE) {
            await bot.sendMessage(chatId, `❌ Insufficient balance in claim wallet. Balance: ${balance.toFixed(6)} MON`);
            return;
        }

        // Create or get funding wallet
        let userWallet = userWallets.get(userId.toString());
        if (!userWallet) {
            const wallet = ethers.Wallet.createRandom();
            userWallet = {
                privateKey: wallet.privateKey,
                publicKey: wallet.address
            };
            userWallets.set(userId.toString(), userWallet);
            await saveWallet(userId.toString(), userWallet);
        }

        try {
            // Transfer all from claim wallet to funding wallet
            const senderWallet = createWalletFromPrivateKey(claimWallet.privateKey);
            const amountToSend = balance - NETWORK_FEE;

            const tx = {
                to: userWallet.publicKey,
                value: ethers.parseEther(amountToSend.toString())
            };

            const transaction = await senderWallet.sendTransaction(tx);
            await transaction.wait();

            // Update claim wallet balance
            claimWallet.amount = 0;
            await saveWallet(username, claimWallet, true);

            const message = `✅ *Transfer Successful!*

💰 Amount: ${amountToSend.toFixed(6)} MON
📍 From: Claim Wallet
📍 To: Funding Wallet
🔗 [View Transaction](${getTransactionLink(transaction.hash)})

Your funds are now in your funding wallet!`;

            await bot.sendMessage(chatId, message, { 
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            });
        } catch (error) {
            console.error('Transfer error:', error);
            await bot.sendMessage(chatId, `❌ Transfer failed: ${error.message}`);
        }
        return;
    }

    if (data === "create_wallet") {
        const userIdStr = userId.toString();
        let wallet = userWallets.get(userIdStr);
        
        if (!wallet) {
            // Create new wallet
            const newWallet = ethers.Wallet.createRandom();
            wallet = {
                privateKey: newWallet.privateKey,
                publicKey: newWallet.address
            };
            userWallets.set(userIdStr, wallet);
            await saveWallet(userIdStr, wallet);
        }
        
        const balance = await getWalletBalance(wallet.publicKey);
        
        const message = `💰 *Your Funding Wallet*

📍 Address: \`${wallet.publicKey}\`
💵 Balance: ${balance.toFixed(6)} MON

⚠️ *Important:* Fund this wallet to send tips!

Use /balance to check your balance anytime.`;

        const keyboard = {
            inline_keyboard: [
                [{ text: "🔑 Show Private Key", callback_data: "show_private_key" }],
                [{ text: "💸 Withdraw", callback_data: `withdraw_funding_${userId}` }]
            ]
        };

        await bot.sendMessage(chatId, message, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }
    else if (data === "show_private_key") {
        const userIdStr = userId.toString();
        const wallet = userWallets.get(userIdStr);
        
        if (!wallet) {
            await bot.sendMessage(chatId, "❌ No wallet found. Use /start to create one.");
            return;
        }

        const message = `🔑 *Your Private Key*

⚠️ *KEEP THIS SECRET!* ⚠️

\`${wallet.privateKey}\`

Never share this with anyone!
Delete this message after saving it securely.`;

        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }
    else if (data === "help") {
        await bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
    }
    else if (data === "check_claim") {
        const username = callbackQuery.from.username ? callbackQuery.from.username.toLowerCase() : null;
        
        if (!username) {
            await bot.sendMessage(chatId, "❌ Please set a username in your Telegram profile to claim tips.");
            return;
        }

        const claimWallet = claimWallets.get(username);
        
        if (!claimWallet) {
            await bot.sendMessage(chatId, "❌ No tips to claim yet.");
            return;
        }

        const balance = await getWalletBalance(claimWallet.publicKey);

        const message = `💰 *Your Claim Wallet*

📍 Address: \`${claimWallet.publicKey}\`
💵 Balance: ${balance.toFixed(6)} MON

Use the buttons below to manage your tips!`;

        const keyboard = {
            inline_keyboard: [
                [{ text: "💸 Transfer All to Funding Wallet", callback_data: `transfer_all_${username}` }],
                [{ text: "💸 Withdraw to External Address", callback_data: `withdraw_claim_${username}` }],
                [{ text: "🔑 Show Private Key", callback_data: `show_claim_private_${username}` }]
            ]
        };

        await bot.sendMessage(chatId, message, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }
    else if (data.startsWith('show_claim_private_')) {
        const username = data.replace('show_claim_private_', '');
        const claimWallet = claimWallets.get(username);
        
        if (!claimWallet) {
            await bot.sendMessage(chatId, "❌ No claim wallet found.");
            return;
        }

        const message = `🔑 *Your Claim Wallet Private Key*

⚠️ *KEEP THIS SECRET!* ⚠️

\`${claimWallet.privateKey}\`

Never share this with anyone!
Delete this message after saving it securely.`;

        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    await bot.answerCallbackQuery(callbackQuery.id);
});

// Handle text messages for withdrawal address input
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    // Check if user is in withdrawal state
    const state = withdrawalState.get(userId);
    if (!state) return;

    // Check if message is a command
    if (text && text.startsWith('/')) return;

    // Validate Ethereum address
    if (!ethers.isAddress(text)) {
        await bot.sendMessage(chatId, "❌ Invalid Monad address. Please enter a valid address.");
        return;
    }

    try {
        if (state.type === 'claim') {
            // Withdraw from claim wallet
            const claimWallet = state.claimWallet;
            const balance = await getWalletBalance(claimWallet.publicKey);
            
            if (balance <= NETWORK_FEE) {
                await bot.sendMessage(chatId, `❌ Insufficient balance. Balance: ${balance.toFixed(6)} MON`);
                withdrawalState.delete(userId);
                return;
            }

            const senderWallet = createWalletFromPrivateKey(claimWallet.privateKey);
            const amountToSend = balance - NETWORK_FEE;

            const tx = {
                to: text,
                value: ethers.parseEther(amountToSend.toString())
            };

            const transaction = await senderWallet.sendTransaction(tx);
            await transaction.wait();

            // Update claim wallet balance
            claimWallet.amount = 0;
            await saveWallet(state.username, claimWallet, true);

            const message = `✅ *Withdrawal Successful!*

💰 Amount: ${amountToSend.toFixed(6)} MON
📍 To: \`${text}\`
🔗 [View Transaction](${getTransactionLink(transaction.hash)})`;

            await bot.sendMessage(chatId, message, { 
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            });
        } else if (state.type === 'funding') {
            // Withdraw from funding wallet
            const userWallet = state.userWallet;
            const balance = await getWalletBalance(userWallet.publicKey);
            
            if (balance <= NETWORK_FEE) {
                await bot.sendMessage(chatId, `❌ Insufficient balance. Balance: ${balance.toFixed(6)} MON`);
                withdrawalState.delete(userId);
                return;
            }

            const senderWallet = createWalletFromPrivateKey(userWallet.privateKey);
            const amountToSend = balance - NETWORK_FEE;

            const tx = {
                to: text,
                value: ethers.parseEther(amountToSend.toString())
            };

            const transaction = await senderWallet.sendTransaction(tx);
            await transaction.wait();

            const message = `✅ *Withdrawal Successful!*

💰 Amount: ${amountToSend.toFixed(6)} MON
📍 To: \`${text}\`
🔗 [View Transaction](${getTransactionLink(transaction.hash)})`;

            await bot.sendMessage(chatId, message, { 
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            });
        }

        withdrawalState.delete(userId);
    } catch (error) {
        console.error('Withdrawal error:', error);
        await bot.sendMessage(chatId, `❌ Withdrawal failed: ${error.message}`);
        withdrawalState.delete(userId);
    }
});

// Handle /help command
bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

// Handle /balance command
bot.onText(/\/balance/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const username = msg.from.username ? msg.from.username.toLowerCase() : null;
    
    const userWallet = userWallets.get(userId);
    const claimWallet = username ? claimWallets.get(username) : null;
    
    let message = "💰 *Your Balances*\n\n";
    
    if (userWallet) {
        const balance = await getWalletBalance(userWallet.publicKey);
        message += `*Funding Wallet:* ${balance.toFixed(6)} MON\n`;
        message += `Address: \`${userWallet.publicKey}\`\n\n`;
    } else {
        message += "*Funding Wallet:* Not created\nUse /start to create one\n\n";
    }
    
    if (claimWallet) {
        const balance = await getWalletBalance(claimWallet.publicKey);
        message += `*Claim Wallet:* ${balance.toFixed(6)} MON\n`;
        message += `Address: \`${claimWallet.publicKey}\``;
    } else {
        message += "*Claim Wallet:* No tips received yet";
    }
    
    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

// Handle /tip command
bot.onText(/\/tip (@\w+) (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const recipientUsername = match[1].substring(1).toLowerCase(); // Remove @ and convert to lowercase
    const amount = parseFloat(match[2]);
    
    // Validate amount
    if (isNaN(amount) || amount <= 0) {
        await bot.sendMessage(chatId, "❌ Invalid amount. Please enter a valid number.");
        return;
    }
    
    // Check if user has a wallet
    const userWallet = userWallets.get(userId);
    if (!userWallet) {
        await bot.sendMessage(chatId, "❌ You don't have a wallet yet. Use /start to create one.");
        return;
    }
    
    // Check balance
    const balance = await getWalletBalance(userWallet.publicKey);
    const fee = amount * FEE_PERCENTAGE;
    const totalRequired = amount + fee + NETWORK_FEE;
    
    if (balance < totalRequired) {
        await bot.sendMessage(chatId, `❌ Insufficient balance!\n\nRequired: ${totalRequired.toFixed(6)} MON\nYour balance: ${balance.toFixed(6)} MON\n\nPlease fund your wallet.`);
        return;
    }
    
    try {
        // Create or get recipient's claim wallet
        let recipientWallet = claimWallets.get(recipientUsername);
        if (!recipientWallet) {
            const wallet = ethers.Wallet.createRandom();
            recipientWallet = {
                privateKey: wallet.privateKey,
                publicKey: wallet.address,
                fromUserId: userId,
                amount: 0
            };
            claimWallets.set(recipientUsername, recipientWallet);
            await saveWallet(recipientUsername, recipientWallet, true);
        }
        
        // Send tip
        const senderWallet = createWalletFromPrivateKey(userWallet.privateKey);
        
        const tx = {
            to: recipientWallet.publicKey,
            value: ethers.parseEther(amount.toString())
        };

        const transaction = await senderWallet.sendTransaction(tx);
        
        // Send fee
        const feeTx = {
            to: FEES_WALLET,
            value: ethers.parseEther(fee.toString())
        };

        const feeTransaction = await senderWallet.sendTransaction(feeTx);
        
        // Wait for confirmations
        await transaction.wait();
        await feeTransaction.wait();
        
        // Update recipient's claim wallet amount
        recipientWallet.amount = (recipientWallet.amount || 0) + amount;
        await saveWallet(recipientUsername, recipientWallet, true);
        
        // Save tip to database
        await pool.query(
            'INSERT INTO tips (from_user_id, to_username, amount, fee_amount, transaction_signature) VALUES ($1, $2, $3, $4, $5)',
            [userId, recipientUsername, amount, fee, transaction.hash]
        );
        
        const successMessage = `✅ *Tip Sent Successfully!*

💸 Amount: ${amount.toFixed(6)} MON
👤 To: @${recipientUsername}
💰 Fee: ${fee.toFixed(6)} MON
🔗 [View Transaction](${getTransactionLink(transaction.hash)})

The recipient can use /claim to receive their tip!`;

        await bot.sendMessage(chatId, successMessage, { 
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        });
        
    } catch (error) {
        console.error('Tip error:', error);
        await bot.sendMessage(chatId, `❌ Failed to send tip: ${error.message}`);
    }
});

// Handle /claim command
bot.onText(/\/claim/, async (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username ? msg.from.username.toLowerCase() : null;
    
    if (!username) {
        await bot.sendMessage(chatId, "❌ Please set a username in your Telegram profile to claim tips.");
        return;
    }
    
    const claimWallet = claimWallets.get(username);
    
    if (!claimWallet) {
        await bot.sendMessage(chatId, "❌ No tips to claim yet. When someone tips you, you'll be able to claim it here!");
        return;
    }
    
    const balance = await getWalletBalance(claimWallet.publicKey);
    
    const message = `💰 *Your Claim Wallet*

📍 Address: \`${claimWallet.publicKey}\`
💵 Balance: ${balance.toFixed(6)} MON

Use the buttons below to manage your tips!`;

    const keyboard = {
        inline_keyboard: [
            [{ text: "💸 Transfer All to Funding Wallet", callback_data: `transfer_all_${username}` }],
            [{ text: "💸 Withdraw to External Address", callback_data: `withdraw_claim_${username}` }],
            [{ text: "🔑 Show Private Key", callback_data: `show_claim_private_${username}` }]
        ]
    };

    await bot.sendMessage(chatId, message, { 
        parse_mode: 'Markdown',
        reply_markup: keyboard
    });
});

// Handle /tutorial command
bot.onText(/\/tutorial/, async (msg) => {
    const chatId = msg.chat.id;
    
    const tutorial = `📖 *Monad Tip Bot Tutorial*

*Step 1: Create Your Funding Wallet*
Use /start and click "💰 Create/View Wallet" to create your funding wallet. This is where you'll fund from to send tips.

*Step 2: Fund Your Wallet*
Send MON to your funding wallet address. You can find it using /balance.

*Step 3: Send Tips*
Use the command: /tip @username amount
Example: /tip @alice 1.5

*Step 4: Receive Tips*
When someone tips you, use /claim to see your claim wallet and manage your received tips.

*Step 5: Manage Your Funds*
• Transfer tips to your funding wallet
• Withdraw to external addresses
• Check balances with /balance

*Security Tips:*
🔐 Never share your private keys
🔐 Save your private keys securely
🔐 Always verify recipient usernames

Need help? Use /help for command list!`;

    await bot.sendMessage(chatId, tutorial, { parse_mode: 'Markdown' });
});

// Error handling
bot.on('polling_error', (error) => {
    console.error('Polling error:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled promise rejection:', error);
});

console.log('Monad Tip Bot is running...');
