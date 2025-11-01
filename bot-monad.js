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

// Rate limiting helper
let lastRpcCall = 0;
const MIN_RPC_DELAY = 100; // Minimum 100ms between RPC calls

async function rateLimitedDelay() {
    const now = Date.now();
    const timeSinceLastCall = now - lastRpcCall;
    if (timeSinceLastCall < MIN_RPC_DELAY) {
        await new Promise(resolve => setTimeout(resolve, MIN_RPC_DELAY - timeSinceLastCall));
    }
    lastRpcCall = Date.now();
}

// Helper function to send transaction with retry logic
async function sendTransactionWithRetry(wallet, tx, options = {}) {
    const { maxRetries = 3, onSent, onConfirming, onConfirmed } = options;

    const invokeCallback = async (callback, transaction) => {
        if (!callback) return;
        try {
            await callback(transaction);
        } catch (callbackError) {
            console.error('Callback error in sendTransactionWithRetry:', callbackError);
        }
    };

    for (let i = 0; i < maxRetries; i++) {
        try {
            await rateLimitedDelay();
            const transaction = await wallet.sendTransaction(tx);
            await invokeCallback(onSent, transaction);
            await rateLimitedDelay();
            await invokeCallback(onConfirming, transaction);
            await transaction.wait();
            await invokeCallback(onConfirmed, transaction);
            return transaction;
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            
            // If nonce error or rate limit, refresh nonce and retry
            if (error.message.includes('nonce') || error.message.includes('priority') || error.message.includes('rate') || error.message.includes('limit')) {
                console.log(`Error detected, retrying... (attempt ${i + 1}/${maxRetries}): ${error.message}`);
                await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds before retry
                await rateLimitedDelay();
                const newNonce = await provider.getTransactionCount(wallet.address, 'latest');
                tx.nonce = newNonce;
            } else {
                throw error;
            }
        }
    }
}

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
        await rateLimitedDelay();
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

*Basic Commands:*
/start - Create your funding wallet
/pay @username amount - Send MON to someone
/claim - Claim your received payments
/balance - Check your wallet balance
/help - Show this help message
/tutorial - Show the tutorial again

*Group Giveaway Commands:*
/random <winners> <role> <amount> - Random giveaway to group members
/gmonad <amount> - Interactive giveaway (users say "gmonad" to enter)

*Examples:*
• /pay @john 0.5
• /pay @alice 1.2
• /random 3 admin 0.5 - Give 0.5 MON to 3 random admins
• /gmonad 1.0 - Give 1.0 MON to one random user who says "gmonad"

*Fee Structure:*
• Transaction Fee: 10% of tip amount
• Network Fee: ~0.000005 MON per transaction

*Tips:*
• Always verify the username
• Check your balance before sending
• Keep your private keys safe
• Giveaway commands only work in groups`;

// Add helper function for transaction links
function getTransactionLink(signature) {
    return `https://testnet.monadexplorer.com/tx/${signature}`;
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
    const chatType = msg.chat.type;
    const userId = msg.from.id;
    const username = msg.from.username ? msg.from.username.toLowerCase() : null;
    const startParam = match[1]; // Get the start parameter if any
    
    // Only works in private chats
    if (chatType === 'group' || chatType === 'supergroup') {
        const botUsername = (await bot.getMe()).username;
        await bot.sendMessage(chatId, `❌ Please use /start in a private message with @${botUsername}!`);
        return;
    }
    
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
            
            // Estimate gas for the transaction
            await rateLimitedDelay();
            const gasEstimate = await provider.estimateGas({
                from: senderWallet.address,
                to: userWallet.publicKey,
                value: ethers.parseEther(balance.toString())
            });
            
            await rateLimitedDelay();
            const gasPrice = await provider.getFeeData();
            const gasCost = parseFloat(ethers.formatEther(gasEstimate * gasPrice.gasPrice));
            
            // Calculate amount to send (balance - gas cost - small buffer)
            const amountToSend = balance - gasCost - 0.00001;
            
            if (amountToSend <= 0) {
                await bot.sendMessage(chatId, `❌ Insufficient balance to cover gas fees. Balance: ${balance.toFixed(6)} MON, Gas: ${gasCost.toFixed(6)} MON`);
                return;
            }

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
            
            if (balance <= 0.0001) {
                await bot.sendMessage(chatId, `❌ Insufficient balance. Balance: ${balance.toFixed(6)} MON`);
                withdrawalState.delete(userId);
                return;
            }

            const senderWallet = createWalletFromPrivateKey(claimWallet.privateKey);
            
            // Estimate gas for the transaction
            await rateLimitedDelay();
            const gasEstimate = await provider.estimateGas({
                from: senderWallet.address,
                to: text,
                value: ethers.parseEther(balance.toString())
            });
            
            await rateLimitedDelay();
            const gasPrice = await provider.getFeeData();
            const gasCost = parseFloat(ethers.formatEther(gasEstimate * gasPrice.gasPrice));
            
            // Calculate amount to send (balance - gas cost - small buffer)
            const amountToSend = balance - gasCost - 0.00001;
            
            if (amountToSend <= 0) {
                await bot.sendMessage(chatId, `❌ Insufficient balance to cover gas fees. Balance: ${balance.toFixed(6)} MON, Gas: ${gasCost.toFixed(6)} MON`);
                withdrawalState.delete(userId);
                return;
            }

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
            
            if (balance <= 0.0001) {
                await bot.sendMessage(chatId, `❌ Insufficient balance. Balance: ${balance.toFixed(6)} MON`);
                withdrawalState.delete(userId);
                return;
            }

            const senderWallet = createWalletFromPrivateKey(userWallet.privateKey);
            
            // Estimate gas for the transaction
            await rateLimitedDelay();
            const gasEstimate = await provider.estimateGas({
                from: senderWallet.address,
                to: text,
                value: ethers.parseEther(balance.toString())
            });
            
            await rateLimitedDelay();
            const gasPrice = await provider.getFeeData();
            const gasCost = parseFloat(ethers.formatEther(gasEstimate * gasPrice.gasPrice));
            
            // Calculate amount to send (balance - gas cost - small buffer)
            const amountToSend = balance - gasCost - 0.00001;
            
            if (amountToSend <= 0) {
                await bot.sendMessage(chatId, `❌ Insufficient balance to cover gas fees. Balance: ${balance.toFixed(6)} MON, Gas: ${gasCost.toFixed(6)} MON`);
                withdrawalState.delete(userId);
                return;
            }

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
    const chatType = msg.chat.type;
    
    // Only works in private chats
    if (chatType === 'group' || chatType === 'supergroup') {
        const botUsername = (await bot.getMe()).username;
        await bot.sendMessage(chatId, `❌ Please use /help in a private message with @${botUsername}!`);
        return;
    }
    
    await bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

// Handle /balance command
bot.onText(/\/balance/, async (msg) => {
    const chatId = msg.chat.id;
    const chatType = msg.chat.type;
    const userId = msg.from.id.toString();
    
    // Only works in private chats
    if (chatType === 'group' || chatType === 'supergroup') {
        const botUsername = (await bot.getMe()).username;
        await bot.sendMessage(chatId, `❌ Please use /balance in a private message with @${botUsername}!`);
        return;
    }
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

// Handle /pay command
bot.onText(/\/pay (@\w+) (.+)/, async (msg, match) => {
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
    let setStatus = null;

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
        
        const status = {
            sent: false,
            confirming: false,
            success: false,
            failed: false,
            errorMessage: '',
            txHash: null
        };

        const buildStatusText = () => {
            const lines = [
                '🔄 *Payment Status*',
                `Recipient: @${recipientUsername}`,
                `Amount: ${amount.toFixed(6)} MON`
            ];
            if ((status.success || status.failed) && status.txHash) {
                lines.push(`Tx: [View transaction](${getTransactionLink(status.txHash)})`);
            }
            lines.push('');
            lines.push(`${status.failed ? '❌' : status.sent ? '✅' : '⏳'} Sending transaction`);
            lines.push(`${status.failed ? '❌' : status.success ? '✅' : status.confirming ? '⏳' : '○'} Confirming on-chain`);
            if (status.failed) {
                lines.push(`❌ Payment failed: ${status.errorMessage}`);
            } else if (status.success) {
                lines.push('✅ Payment successful!');
            } else {
                lines.push('○ Payment successful!');
            }
            return lines.join('\n');
        };

        const statusMessage = await bot.sendMessage(chatId, buildStatusText(), {
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        });

        const updateStatusMessage = async () => {
            try {
                await bot.editMessageText(buildStatusText(), {
                    chat_id: chatId,
                    message_id: statusMessage.message_id,
                    parse_mode: 'Markdown',
                    disable_web_page_preview: true
                });
            } catch (statusError) {
                const description = statusError?.response?.body?.description || '';
                if (!description.includes('message is not modified')) {
                    console.error('Error updating status message:', statusError);
                }
            }
        };

        setStatus = async (changes) => {
            Object.assign(status, changes);
            await updateStatusMessage();
        };
        
        // Get current nonce
        await rateLimitedDelay();
        let nonce = await provider.getTransactionCount(senderWallet.address, 'latest');
        
        const tx = {
            to: recipientWallet.publicKey,
            value: ethers.parseEther(amount.toString()),
            nonce: nonce
        };

        const transaction = await sendTransactionWithRetry(senderWallet, tx, {
            onSent: async (txResponse) => {
                await setStatus({ sent: true, confirming: true, txHash: txResponse.hash });
            },
            onConfirming: async () => {
                await setStatus({ confirming: true });
            },
            onConfirmed: async (txResponse) => {
                await setStatus({ confirming: false, success: true, txHash: txResponse.hash });
            }
        });
        
        // Get fresh nonce for fee transaction
        await rateLimitedDelay();
        const feeNonce = await provider.getTransactionCount(senderWallet.address, 'latest');
        
        // Send fee with fresh nonce
        const feeTx = {
            to: FEES_WALLET,
            value: ethers.parseEther(fee.toString()),
            nonce: feeNonce
        };

        const feeTransaction = await sendTransactionWithRetry(senderWallet, feeTx);
        
        // Update recipient's claim wallet amount
        recipientWallet.amount = (recipientWallet.amount || 0) + amount;
        await saveWallet(recipientUsername, recipientWallet, true);
        
        // Save tip to database
        await pool.query(
            'INSERT INTO payments (from_user_id, to_username, amount, fee_amount, transaction_signature) VALUES ($1, $2, $3, $4, $5)',
            [userId, recipientUsername, amount, fee, transaction.hash]
        );
        
        const successMessage = `✅ *Payment Sent Successfully!*

💰 Amount: ${amount.toFixed(6)} MON
💵 Fee: ${fee.toFixed(6)} MON (10%)
📍 To: @${recipientUsername}
🔗 [View Transaction](${getTransactionLink(transaction.hash)})

The recipient can use /claim to receive their payment!`;

        await bot.sendMessage(chatId, successMessage, { 
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        });
        
    } catch (error) {
        console.error('Tip error:', error);
        if (setStatus) {
            await setStatus({ failed: true, confirming: false, sent: !!status?.sent, errorMessage: error.message });
        }
        await bot.sendMessage(chatId, `❌ Failed to send payment: ${error.message}`);
    }
});

// Handle /claim command
bot.onText(/\/claim/, async (msg) => {
    const chatId = msg.chat.id;
    const chatType = msg.chat.type;
    const username = msg.from.username ? msg.from.username.toLowerCase() : null;
    
    // Only works in private chats
    if (chatType === 'group' || chatType === 'supergroup') {
        const botUsername = (await bot.getMe()).username;
        await bot.sendMessage(chatId, `❌ Please use /claim in a private message with @${botUsername}, not in the group!`);
        return;
    }
    
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
    const chatType = msg.chat.type;
    
    // Only works in private chats
    if (chatType === 'group' || chatType === 'supergroup') {
        const botUsername = (await bot.getMe()).username;
        await bot.sendMessage(chatId, `❌ Please use /tutorial in a private message with @${botUsername}!`);
        return;
    }
    
    const tutorial = `📖 *Monad Tip Bot Tutorial*

*Step 1: Create Your Funding Wallet*
Use /start and click "💰 Create/View Wallet" to create your funding wallet. This is where you'll fund from to send tips.

*Step 2: Fund Your Wallet*
Send MON to your funding wallet address. You can find it using /balance.

*Step 3: Send Payments*
Use the command: /pay @username amount
Example: /pay @alice 1.5

*Step 4: Receive Payments*
When someone pays you, use /claim to see your claim wallet and manage your received payments.

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

// Store active gmonad giveaways
const activeGmonadGiveaways = new Map();

// Handle /random command - Random giveaway to group members
bot.onText(/\/random(?:\s+(\d+)\s+(\w+)\s+([\d.]+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const chatType = msg.chat.type;
    
    // Only works in groups
    if (chatType !== 'group' && chatType !== 'supergroup') {
        await bot.sendMessage(chatId, "❌ This command only works in groups!");
        return;
    }
    
    // Check if user is admin
    try {
        const member = await bot.getChatMember(chatId, msg.from.id);
        if (member.status !== 'creator' && member.status !== 'administrator') {
            await bot.sendMessage(chatId, "❌ Only group admins can use this command!");
            return;
        }
    } catch (error) {
        console.error('Error checking admin status:', error);
        await bot.sendMessage(chatId, "❌ Could not verify admin status.");
        return;
    }
    
    if (!match[1] || !match[2] || !match[3]) {
        await bot.sendMessage(chatId, `❌ *Invalid format!*

Usage: \`/random <number of winners> <role> <amount>\`

*Roles:*
• \`admin\` - Only admins
• \`member\` or \`all\` - All members

*Example:*
\`/random 3 member 0.5\` - Give 0.5 MON to 3 random members`, 
            { parse_mode: 'Markdown' });
        return;
    }
    
    const numberOfWinners = parseInt(match[1]);
    const role = match[2].toLowerCase();
    const amount = parseFloat(match[3]);
    
    if (numberOfWinners <= 0 || numberOfWinners > 50) {
        await bot.sendMessage(chatId, "❌ Number of winners must be between 1 and 50!");
        return;
    }
    
    if (isNaN(amount) || amount <= 0) {
        await bot.sendMessage(chatId, "❌ Invalid amount!");
        return;
    }
    
    if (role !== 'admin' && role !== 'member' && role !== 'all') {
        await bot.sendMessage(chatId, "❌ Invalid role! Use: admin, member, or all");
        return;
    }
    
    // Check sender's wallet and balance
    const userWallet = userWallets.get(userId);
    if (!userWallet) {
        await bot.sendMessage(chatId, "❌ You don't have a wallet yet. Use /start to create one.");
        return;
    }
    
    const balance = await getWalletBalance(userWallet.publicKey);
    const fee = amount * FEE_PERCENTAGE;
    const totalPerWinner = amount + fee + NETWORK_FEE;
    const totalRequired = totalPerWinner * numberOfWinners;
    
    if (balance < totalRequired) {
        await bot.sendMessage(chatId, `❌ *Insufficient balance!*

Required: ${totalRequired.toFixed(6)} MON
Your balance: ${balance.toFixed(6)} MON

(${amount} MON × ${numberOfWinners} winners + fees)`, 
            { parse_mode: 'Markdown' });
        return;
    }
    
    try {
        // Get chat administrators
        const admins = await bot.getChatAdministrators(chatId);
        const adminIds = admins.map(admin => admin.user.id);
        
        let eligibleMembers = [];
        
        if (role === 'admin') {
            // Only admins with usernames
            eligibleMembers = admins
                .filter(admin => admin.user.username && !admin.user.is_bot && admin.user.id !== msg.from.id)
                .map(admin => ({
                    id: admin.user.id,
                    username: admin.user.username,
                    firstName: admin.user.first_name
                }));
        } else {
            // For members, use admins as eligible members
            // Note: This is a simplified approach - in production, track members over time in database
            eligibleMembers = admins
                .filter(admin => admin.user.username && !admin.user.is_bot && admin.user.id !== msg.from.id)
                .map(admin => ({
                    id: admin.user.id,
                    username: admin.user.username,
                    firstName: admin.user.first_name
                }));
        }
        
        if (eligibleMembers.length === 0) {
            await bot.sendMessage(chatId, `❌ No eligible members found with the role "${role}". Members must have a username set.`);
            return;
        }
        
        if (eligibleMembers.length < numberOfWinners) {
            await bot.sendMessage(chatId, `❌ Not enough eligible members! Found ${eligibleMembers.length}, need ${numberOfWinners}.`);
            return;
        }
        
        // Randomly select winners using Fisher-Yates shuffle
        const shuffled = [...eligibleMembers];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        const winners = shuffled.slice(0, numberOfWinners);
        
        await bot.sendMessage(chatId, `🎲 *Drawing ${numberOfWinners} winners...*`, { parse_mode: 'Markdown' });
        
        // Send tips to all winners
        const senderWallet = createWalletFromPrivateKey(userWallet.privateKey);
        const successfulWinners = [];
        const failedWinners = [];
        
        for (const winner of winners) {
            try {
                // Create or get recipient's claim wallet
                const recipientUsername = winner.username.toLowerCase();
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
                
                // Get fresh nonce for each transaction
                await rateLimitedDelay();
                const nonce = await provider.getTransactionCount(senderWallet.address, 'latest');
                
                const tx = {
                    to: recipientWallet.publicKey,
                    value: ethers.parseEther(amount.toString()),
                    nonce: nonce
                };
                
                const transaction = await sendTransactionWithRetry(senderWallet, tx);
                
                // Send fee
                await rateLimitedDelay();
                const feeNonce = await provider.getTransactionCount(senderWallet.address, 'latest');
                const feeTx = {
                    to: FEES_WALLET,
                    value: ethers.parseEther(fee.toString()),
                    nonce: feeNonce
                };
                
                await sendTransactionWithRetry(senderWallet, feeTx);
                
                // Update recipient's claim wallet amount
                recipientWallet.amount = (recipientWallet.amount || 0) + amount;
                await saveWallet(recipientUsername, recipientWallet, true);
                
                // Save to database
                await pool.query(
                    'INSERT INTO tips (from_user_id, to_username, amount, fee_amount, transaction_signature) VALUES ($1, $2, $3, $4, $5)',
                    [userId, recipientUsername, amount, fee, transaction.hash]
                );
                
                successfulWinners.push({ ...winner, txHash: transaction.hash });
            } catch (error) {
                console.error(`Error tipping ${winner.username}:`, error);
                failedWinners.push(winner);
            }
        }
        
        // Build success message
        let message = `🎉 *Random Giveaway Complete!*\n\n`;
        message += `💰 Amount per winner: ${amount.toFixed(6)} MON\n`;
        message += `🏆 Winners (${successfulWinners.length}):\n\n`;
        
        successfulWinners.forEach((winner, index) => {
            message += `${index + 1}. @${winner.username}\n`;
        });
        
        message += `\n✅ *How to claim:*\n`;
        message += `1. Send /claim to @${(await bot.getMe()).username} (in private message)\n`;
        message += `2. View your received tips\n`;
        message += `3. Transfer to your funding wallet or withdraw\n\n`;
        message += `💡 Winners will see the tips in their claim wallet!`;
        
        if (failedWinners.length > 0) {
            message += `\n\n⚠️ Failed to send to: `;
            message += failedWinners.map(w => `@${w.username}`).join(', ');
        }
        
        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        
    } catch (error) {
        console.error('Random giveaway error:', error);
        await bot.sendMessage(chatId, `❌ Giveaway failed: ${error.message}`);
    }
});

// Handle /gmonad command - Interactive giveaway
bot.onText(/\/gmonad(?:\s+([\d.]+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const chatType = msg.chat.type;
    
    // Only works in groups
    if (chatType !== 'group' && chatType !== 'supergroup') {
        await bot.sendMessage(chatId, "❌ This command only works in groups!");
        return;
    }
    
    if (!match[1]) {
        await bot.sendMessage(chatId, `❌ *Invalid format!*

Usage: \`/gmonad <amount>\`

*Example:*
\`/gmonad 1.0\` - Give 1.0 MON to one random user who says "gmonad"`, 
            { parse_mode: 'Markdown' });
        return;
    }
    
    const amount = parseFloat(match[1]);
    
    if (isNaN(amount) || amount <= 0) {
        await bot.sendMessage(chatId, "❌ Invalid amount!");
        return;
    }
    
    // Check sender's wallet and balance
    const userWallet = userWallets.get(userId);
    if (!userWallet) {
        await bot.sendMessage(chatId, "❌ You don't have a wallet yet. Use /start to create one.");
        return;
    }
    
    const balance = await getWalletBalance(userWallet.publicKey);
    const fee = amount * FEE_PERCENTAGE;
    const totalRequired = amount + fee + NETWORK_FEE;
    
    if (balance < totalRequired) {
        await bot.sendMessage(chatId, `❌ *Insufficient balance!*

Required: ${totalRequired.toFixed(6)} MON
Your balance: ${balance.toFixed(6)} MON`, 
            { parse_mode: 'Markdown' });
        return;
    }
    
    // Store active giveaway
    const giveawayKey = `${chatId}_${Date.now()}`;
    activeGmonadGiveaways.set(giveawayKey, {
        chatId,
        senderId: userId,
        senderWallet: userWallet,
        amount,
        fee,
        participants: new Map(), // Use Map to store by userId
        messageId: msg.message_id,
        startTime: Date.now()
    });
    
    // Auto-close after 60 seconds
    setTimeout(async () => {
        const giveaway = activeGmonadGiveaways.get(giveawayKey);
        if (giveaway && giveaway.participants.size > 0) {
            await closeGmonadGiveaway(giveawayKey);
        } else if (giveaway) {
            activeGmonadGiveaways.delete(giveawayKey);
            await bot.sendMessage(chatId, "⏰ GM giveaway ended - no participants!");
        }
    }, 60000); // 60 seconds
    
    const message = `🌅 *GM Giveaway Started!*

💰 Prize: ${amount.toFixed(6)} MON
⏰ Time: 60 seconds
📝 To enter: Reply "gmonad" to this message

Good luck! 🍀`;
    
    await bot.sendMessage(chatId, message, { 
        parse_mode: 'Markdown',
        reply_to_message_id: msg.message_id
    });
});

// Listen for "gmonad" messages
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text?.toLowerCase().trim();
    const userId = msg.from.id;
    const username = msg.from.username;
    
    if (!text || !username) return;
    
    // Check if message is "gmonad"
    if (text === 'gmonad' || text === 'gm' || text === 'gm monad') {
        // Check all active giveaways in this chat
        for (const [key, giveaway] of activeGmonadGiveaways.entries()) {
            if (giveaway.chatId === chatId) {
                // Add participant to Map (will not add duplicates)
                // Allow everyone including the sender to participate
                if (!giveaway.participants.has(userId)) {
                    giveaway.participants.set(userId, {
                        id: userId,
                        username: username
                    });
                    console.log(`User ${username} (${userId}) entered giveaway ${key}. Total participants: ${giveaway.participants.size}`);
                }
                
                break;
            }
        }
    }
});

// Helper function to close gmonad giveaway
async function closeGmonadGiveaway(giveawayKey) {
    const giveaway = activeGmonadGiveaways.get(giveawayKey);
    if (!giveaway) return;
    
    const participants = Array.from(giveaway.participants.values());
    
    if (participants.length === 0) {
        await bot.sendMessage(giveaway.chatId, "⏰ GM giveaway ended - no participants!");
        activeGmonadGiveaways.delete(giveawayKey);
        return;
    }
    
    // Pick random winner
    const winner = participants[Math.floor(Math.random() * participants.length)];
    console.log(`GM giveaway winner: ${winner.username} from ${participants.length} participants`);
    
    try {
        // Send tip to winner
        const senderWallet = createWalletFromPrivateKey(giveaway.senderWallet.privateKey);
        
        // Create or get recipient's claim wallet
        const recipientUsername = winner.username.toLowerCase();
        let recipientWallet = claimWallets.get(recipientUsername);
        
        if (!recipientWallet) {
            const wallet = ethers.Wallet.createRandom();
            recipientWallet = {
                privateKey: wallet.privateKey,
                publicKey: wallet.address,
                fromUserId: giveaway.senderId,
                amount: 0
            };
            claimWallets.set(recipientUsername, recipientWallet);
            await saveWallet(recipientUsername, recipientWallet, true);
        }
        
        // Get fresh nonce
        await rateLimitedDelay();
        const nonce = await provider.getTransactionCount(senderWallet.address, 'latest');
        
        const tx = {
            to: recipientWallet.publicKey,
            value: ethers.parseEther(giveaway.amount.toString()),
            nonce: nonce
        };
        
        const transaction = await sendTransactionWithRetry(senderWallet, tx);
        
        // Send fee
        await rateLimitedDelay();
        const feeNonce = await provider.getTransactionCount(senderWallet.address, 'latest');
        const feeTx = {
            to: FEES_WALLET,
            value: ethers.parseEther(giveaway.fee.toString()),
            nonce: feeNonce
        };
        
        await sendTransactionWithRetry(senderWallet, feeTx);
        
        // Update recipient's claim wallet amount
        recipientWallet.amount = (recipientWallet.amount || 0) + giveaway.amount;
        await saveWallet(recipientUsername, recipientWallet, true);
        
        // Save to database
        await pool.query(
            'INSERT INTO tips (from_user_id, to_username, amount, fee_amount, transaction_signature) VALUES ($1, $2, $3, $4, $5)',
            [giveaway.senderId, recipientUsername, giveaway.amount, giveaway.fee, transaction.hash]
        );
        
        const message = `🎉 *GM Giveaway Winner!*

🏆 Winner: @${winner.username}
💰 Prize: ${giveaway.amount.toFixed(6)} MON
👥 Participants: ${participants.length}
🔗 [View Transaction](${getTransactionLink(transaction.hash)})

✅ *How to claim:*
@${winner.username}, send /claim to me in a private message to access your prize!

GM! 🌅`;
        
        await bot.sendMessage(giveaway.chatId, message, { 
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        });
        
    } catch (error) {
        console.error('GM giveaway error:', error);
        await bot.sendMessage(giveaway.chatId, `❌ Failed to send prize: ${error.message}`);
    }
    
    activeGmonadGiveaways.delete(giveawayKey);
}

// Error handling
bot.on('polling_error', (error) => {
    console.error('Polling error:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled promise rejection:', error);
});

console.log('Monad Tip Bot is running...');
