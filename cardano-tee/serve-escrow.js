const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { keccak256 } = require('ethers')
const Cardano = require('@emurgo/cardano-serialization-lib-node');
const crypto = require('crypto');
// Fund the escrow wallet
const axios = require('axios');
const BLOCKFROST_API_KEY = process.env.BLOCKFROST_API_KEY;
const BLOCKFROST_API_URL = 'https://cardano-testnet.blockfrost.io/api/v0';




class CardanoEscrowTEE {
    constructor(config = {}) {
        this.client = null;
        this.config = {
            //network: config.network || 'wss://s.altnet.rippletest.net:51233', // testnet by default
            port: config.port || 3000,
            rescueDelay: config.rescueDelay || 86400 * 7, // 7 days in seconds
            ...config
        };

        // Store active escrows
        this.escrows = new Map();
        this.walletSeeds = new Map(); // Securely store wallet seeds

        this.app = express();
        this.setupMiddleware();
        this.setupRoutes();
    }

    setupMiddleware() {
        this.app.use(cors());
        this.app.use(express.json());
        this.app.use((req, res, next) => {
            console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
            next();
        });
    }

    async initialize() {
        /*try {
            this.client = new xrpl.Client(this.config.network);
            await this.client.connect();
            console.log(`Connected to XRPL ${this.config.network}`);
            return true;
        } catch (error) {
            console.error('Failed to connect to XRPL:', error);
            return false;
        }*/
        //console.log("Nothing to intialize for Cardano");
    }

    // Generate a deterministic Cardano wallet from static string
    async  generateCardanoEscrowWallet() {
        const staticSeedPhrase = 'cardano-escrow-wallet'; // your static secret
        const seed = crypto.createHash('sha256').update(staticSeedPhrase).digest(); // 32 bytes

        const entropy = seed; // or seed.slice(0, 32);
        const rootKey = Cardano.Bip32PrivateKey.from_bip39_entropy(entropy, Buffer.from(''));

        const accountKey = rootKey.derive(1852 | 0x80000000)  // purpose
            .derive(1815 | 0x80000000)                        // coin type for ADA
            .derive(0 | 0x80000000);                         // account index

        const utxoKey = accountKey.derive(0).derive(0).to_public();
        const baseAddress = Cardano.BaseAddress.new(
            0,
            Cardano.StakeCredential.from_keyhash(utxoKey.to_raw_key().hash()),
            Cardano.StakeCredential.from_keyhash(utxoKey.to_raw_key().hash())
        ).to_address().to_bech32();
        console.log("Address of generated escrow wallet:", baseAddress)
        return {
            address: baseAddress,
            rootKeyBech32: rootKey.to_bech32(), // keep this safe, contains private keys
            publicKeyHex: Buffer.from(utxoKey.to_raw_key().as_bytes()).toString('hex')
        };
    }

    // Hash function equivalent to Solidity keccak256
    mykeccak256(data) {
        return keccak256(data)
    }

    // Time-lock stage enumeration matching Solidity
    TimeStages = {
        SrcWithdrawal: 0,
        SrcPublicWithdrawal: 1,
        SrcCancellation: 2,
        SrcPublicCancellation: 3,
        DstWithdrawal: 4,
        DstPublicWithdrawal: 5,
        DstCancellation: 6
    };

    // Parse timelocks from packed uint256 (similar to Solidity implementation)
    parseTimelocks(packedTimelocks, deployedAt) {
        const data = BigInt(packedTimelocks);
        const stages = {};

        for (let stage = 0; stage < 7; stage++) {
            const bitShift = BigInt(stage * 32);
            const stageOffset = Number((data >> bitShift) & 0xFFFFFFFFn);
            stages[stage] = deployedAt + stageOffset;
        }

        return stages;
    }

    // Check if current time is within valid range for action
    validateTimeWindow(escrow, stage, requireBefore = null, offset = 0) {
        const now = Math.floor(Date.now() / 1000) + offset;
        const stageTime = escrow.timelocks[stage];

        if (now < stageTime) {
            throw new Error(`Action not allowed yet. Wait until ${new Date(stageTime * 1000)}`);
        }

        if (requireBefore !== null) {
            const beforeTime = escrow.timelocks[requireBefore];
            if (now >= beforeTime) {
                throw new Error(`Action window expired at ${new Date(beforeTime * 1000)}`);
            }
        }
    }

    // Validate secret against hashlock
    validateSecret(secret, hashlock) {
        const secretHash = this.mykeccak256(secret);
        if (secretHash.toLowerCase() !== hashlock.toLowerCase()) {
            throw new Error('Invalid secret provided');
        }
    }

    setupRoutes() {
        // Create new destination escrow
        this.app.post('/escrow/create-dst', async (req, res) => {
            try {
                const {
                    orderHash,
                    hashlock,
                    maker,
                    taker,
                    token,
                    amount,
                    safetyDeposit,
                    timelocks,
                    type
                } = req.body;

                // Generate new wallet for this escrow
                const escrowWallet = await this.generateCardanoEscrowWallet();
                const deployedAt = Math.floor(Date.now() / 1000);
                const parsedTimelocks = this.parseTimelocks(timelocks, deployedAt);

                const escrowId = crypto.randomUUID();
                const escrow = {
                    id: escrowId,
                    orderHash,
                    hashlock: hashlock,
                    maker: maker,
                    taker: taker,
                    token: token,
                    amount: BigInt(amount),
                    safetyDeposit: BigInt(safetyDeposit),
                    timelocks: parsedTimelocks,
                    deployedAt,
                    wallet: {
                        address: escrowWallet.address,
                        publicKey: escrowWallet.publicKey
                    },
                    status: 'created',
                    type: type
                };

                // Store escrow and wallet seed securely
                this.escrows.set(escrowId, escrow);
                this.walletSeeds.set(escrowId, escrowWallet.seed);

                res.json({
                    escrowId,
                    walletAddress: escrowWallet.address,
                    requiredDeposit: {
                        ada: token === '0x0000000000000000000000000000000000000000' ?
                            (escrow.amount + escrow.safetyDeposit).toString() :
                            escrow.safetyDeposit.toString(),
                        token: token !== '0x0000000000000000000000000000000000000000' ?
                            escrow.amount.toString() : '0'
                    },
                    timelocks: parsedTimelocks
                });

            } catch (error) {
                console.error('Error creating destination escrow:', error);
                res.status(500).json({ error: error.message });
            }
        });


// Helper: Get total amount received at a Cardano address
async function getCardanoReceivedAmount(address, assetUnit = 'lovelace') {
    try {
        const res = await axios.get(`${BLOCKFROST_API_URL}/addresses/${address}/utxos`, {
            headers: { project_id: BLOCKFROST_API_KEY }
        });

        let total = BigInt(0);
        for (const utxo of res.data) {
            for (const amount of utxo.amount) {
                if (amount.unit === assetUnit) {
                    total += BigInt(amount.quantity);
                }
            }
        }
        return total;
    } catch (err) {
        console.error('Error fetching UTXOs:', err.response?.data || err.message);
        throw new Error('Failed to fetch UTXOs from Blockfrost');
    }
}


this.app.post('/escrow/:escrowId/fund', async (req, res) => {
    try {
        const { escrowId } = req.params;
        const escrow = this.escrows.get(escrowId);

        if (!escrow) {
            return res.status(404).json({ error: 'Escrow not found' });
        }

        const escrowAddress = escrow.wallet.address;
        const isADA = escrow.token === 'lovelace' || escrow.token === null;

        // Determine token identifier for Blockfrost
        const tokenUnit = isADA ? 'lovelace' : escrow.token; // e.g., policyid.assetname
        const received = await getCardanoReceivedAmount(escrowAddress, tokenUnit); // TODO: this would only work once for a deterministic escrow wallet

        const required = isADA
            ? escrow.amount + escrow.safetyDeposit
            : escrow.safetyDeposit; // Native token scenario

        if (received < required) {
            return res.status(400).json({
                error: `Insufficient deposit. Required: ${required}, Received: ${received.toString()}`
            });
        }

        escrow.status = 'funded';
        escrow.receivedAmount = received.toString();
        escrow.fundedAt = Date.now();

        res.json({
            message: 'Escrow funded successfully',
            escrowId,
            receivedAmount: received.toString(),
            token: tokenUnit,
            walletAddress: escrowAddress
        });

    } catch (err) {
        console.error('Cardano funding verification error:', err);
        res.status(500).json({ error: err.message });
    }
});


        // Withdraw from destination escrow (for maker)
        this.app.post('/escrow/:escrowId/withdraw', async (req, res) => {
            try {
                const { escrowId } = req.params;
                const { secret, callerAddress, isPublic = false } = req.body;

                const escrow = this.escrows.get(escrowId);
                if (!escrow) {
                    return res.status(404).json({ error: 'Escrow not found' });
                }

                if (escrow.status !== 'funded') {
                    return res.status(400).json({ error: 'Escrow not funded' });
                }

                // Validate secret
                this.validateSecret(secret, escrow.hashlock);

                // Validate caller and timing
                if (!isPublic) {
                    if (callerAddress !== escrow.taker) {
                        return res.status(403).json({ error: 'Only taker can withdraw during private period' });
                    }
                    this.validateTimeWindow(
                        escrow,
                        this.TimeStages.DstWithdrawal,
                        this.TimeStages.DstCancellation,
                        11 // simulate 11 seconds delay, just like EVM part
                    );
                } else {
                    // Public withdrawal - anyone can call
                    this.validateTimeWindow(
                        escrow,
                        this.TimeStages.DstPublicWithdrawal,
                        this.TimeStages.DstCancellation
                    );
                }

                // Execute withdrawal
                const walletSeed = this.walletSeeds.get(escrowId);
                //const wallet = xrpl.Wallet.fromSeed(walletSeed);
                const wallet = await this.generateCardanoEscrowWallet(); // Use the generated wallet

                const payment = {
                    TransactionType: 'Payment',
                    Account: wallet.address,
                    Destination: escrow.maker,
                    Amount: escrow.amount.toString()
                };
                console.log("Withdrawing from escrow", payment)
                const prepared = await this.client.autofill(payment);
                const signed = wallet.sign(prepared);
                const result = await this.client.submitAndWait(signed.tx_blob);

                if (result.result.meta.TransactionResult === 'tesSUCCESS') {
                    escrow.status = 'withdrawn';
                    escrow.withdrawTx = result.result.hash;
                    escrow.secret = secret;

                    // Send safety deposit to caller
                    if (escrow.safetyDeposit > 0) {
                        const safetyPayment = {
                            TransactionType: 'Payment',
                            Account: wallet.address,
                            Destination: callerAddress,
                            Amount: escrow.safetyDeposit.toString()
                        };

                        const preparedSafety = await this.client.autofill(safetyPayment);
                        const signedSafety = wallet.sign(preparedSafety);
                        await this.client.submitAndWait(signedSafety.tx_blob);
                    }

                    res.json({
                        message: 'Withdrawal successful',
                        txHash: result.result.hash,
                        secret: secret,
                        amount: escrow.amount.toString()
                    });
                } else {
                    throw new Error(`Transaction failed: ${result.result.meta.TransactionResult}`);
                }

            } catch (error) {
                console.error('Error processing withdrawal:', error);
                res.status(500).json({ error: error.message });
            }
        });

        // Cancel destination escrow
        this.app.post('/escrow/:escrowId/cancel', async (req, res) => {
            // This happens if maker does not reveal the secret in time.
            try {
                const { escrowId } = req.params;
                const { callerAddress } = req.body;

                const escrow = this.escrows.get(escrowId);
                if (!escrow) {
                    return res.status(404).json({ error: 'Escrow not found' });
                }

                if (escrow.status !== 'funded') {
                    return res.status(400).json({ error: 'Escrow not funded or already processed' });
                }

                // Validate caller and timing - todo: include nonce signature to ensure PubKey
                if (callerAddress !== escrow.taker) {
                    return res.status(403).json({ error: 'Only taker can cancel' });
                }

                this.validateTimeWindow(escrow, this.TimeStages.DstCancellation, null, 125);

                // Execute cancellation based on escrow type
                const walletSeed = this.walletSeeds.get(escrowId);
                //const wallet = xrpl.Wallet.fromSeed(walletSeed);
                const wallet = await this.generateCardanoEscrowWallet(); // Use the generated wallet, always the same seed - ONLY FOR THE DEMO

                let cancelTxs = [];

                if (escrow.type === 'dst') {
                    // DST escrow: return everything to taker
                    const payment = {
                        TransactionType: 'Payment',
                        Account: wallet.address,
                        Destination: escrow.taker,
                        Amount: (escrow.amount + escrow.safetyDeposit).toString()
                    };

                    const prepared = await this.client.autofill(payment);
                    const signed = wallet.sign(prepared);
                    const result = await this.client.submitAndWait(signed.tx_blob);

                    if (result.result.meta.TransactionResult === 'tesSUCCESS') {
                        cancelTxs.push({
                            recipient: escrow.taker,
                            amount: (escrow.amount + escrow.safetyDeposit).toString(),
                            txHash: result.result.hash
                        });
                    } else {
                        throw new Error(`Payment to taker failed: ${result.result.meta.TransactionResult}`);
                    }
                } else if (escrow.type === 'src') {
                    // SRC escrow: return amount to maker, safety deposit to taker

                    // Return amount to maker
                    if (escrow.amount > 0) {
                        const makerPayment = {
                            TransactionType: 'Payment',
                            Account: wallet.address,
                            Destination: escrow.maker,
                            Amount: escrow.amount.toString()
                        };

                        const preparedMaker = await this.client.autofill(makerPayment);
                        const signedMaker = wallet.sign(preparedMaker);
                        const makerResult = await this.client.submitAndWait(signedMaker.tx_blob);

                        if (makerResult.result.meta.TransactionResult === 'tesSUCCESS') {
                            cancelTxs.push({
                                recipient: escrow.maker,
                                amount: escrow.amount.toString(),
                                txHash: makerResult.result.hash
                            });
                        } else {
                            throw new Error(`Payment to maker failed: ${makerResult.result.meta.TransactionResult}`);
                        }
                    }

                    // Return safety deposit to taker
                    if (escrow.safetyDeposit > 0) {
                        const takerPayment = {
                            TransactionType: 'Payment',
                            Account: wallet.address,
                            Destination: escrow.taker,
                            Amount: escrow.safetyDeposit.toString()
                        };

                        const preparedTaker = await this.client.autofill(takerPayment);
                        const signedTaker = wallet.sign(preparedTaker);
                        const takerResult = await this.client.submitAndWait(signedTaker.tx_blob);

                        if (takerResult.result.meta.TransactionResult === 'tesSUCCESS') {
                            cancelTxs.push({
                                recipient: escrow.taker,
                                amount: escrow.safetyDeposit.toString(),
                                txHash: takerResult.result.hash
                            });
                        } else {
                            throw new Error(`Safety deposit payment to taker failed: ${takerResult.result.meta.TransactionResult}`);
                        }
                    }
                } else {
                    throw new Error(`Unknown escrow type: ${escrow.type}`);
                }

                escrow.status = 'cancelled';
                escrow.cancelTxs = cancelTxs;

                res.json({
                    message: 'Escrow cancelled successfully',
                    escrowType: escrow.type,
                    cancelTxs: cancelTxs,
                    totalRefunded: (escrow.amount + escrow.safetyDeposit).toString()
                });

            } catch (error) {
                console.error('Error cancelling escrow:', error);
                res.status(500).json({ error: error.message });
            }
        });

        // Rescue funds (emergency function)
        this.app.post('/escrow/:escrowId/rescue', async (req, res) => {
            try {
                const { escrowId } = req.params;
                const { callerAddress, amount } = req.body;

                const escrow = this.escrows.get(escrowId);
                if (!escrow) {
                    return res.status(404).json({ error: 'Escrow not found' });
                }

                // Only taker can rescue after rescue delay
                if (callerAddress !== escrow.taker) {
                    return res.status(403).json({ error: 'Only taker can rescue funds' });
                }

                const rescueStart = escrow.deployedAt + this.config.rescueDelay;
                const now = Math.floor(Date.now() / 1000);

                if (now < rescueStart) {
                    return res.status(400).json({
                        error: `Rescue not available until ${new Date(rescueStart * 1000)}`
                    });
                }

                // Execute rescue
                const walletSeed = this.walletSeeds.get(escrowId);
                //const wallet = xrpl.Wallet.fromSeed(walletSeed);
                const wallet = await this.generateCardanoEscrowWallet(); // Use the generated wallet, always the same seed - ONLY FOR THE DEMO

                const payment = {
                    TransactionType: 'Payment',
                    Account: wallet.address,
                    Destination: callerAddress,
                    Amount: amount
                };

                const prepared = await this.client.autofill(payment);
                const signed = wallet.sign(prepared);
                const result = await this.client.submitAndWait(signed.tx_blob);

                if (result.result.meta.TransactionResult === 'tesSUCCESS') {
                    res.json({
                        message: 'Funds rescued successfully',
                        txHash: result.result.hash,
                        amount: amount
                    });
                } else {
                    throw new Error(`Transaction failed: ${result.result.meta.TransactionResult}`);
                }

            } catch (error) {
                console.error('Error rescuing funds:', error);
                res.status(500).json({ error: error.message });
            }
        });

        // Get escrow status
        this.app.get('/escrow/:escrowId', (req, res) => {
            const { escrowId } = req.params;
            const escrow = this.escrows.get(escrowId);

            if (!escrow) {
                return res.status(404).json({ error: 'Escrow not found' });
            }

            // Return escrow info without sensitive data
            const publicEscrow = {
                id: escrow.id,
                orderHash: escrow.orderHash,
                hashlock: escrow.hashlock,
                maker: escrow.maker,
                taker: escrow.taker,
                token: escrow.token,
                amount: escrow.amount.toString(),
                safetyDeposit: escrow.safetyDeposit.toString(),
                timelocks: escrow.timelocks,
                deployedAt: escrow.deployedAt,
                walletAddress: escrow.wallet.address,
                status: escrow.status,
                type: escrow.type
            };

            res.json(publicEscrow);
        });

        // Health check
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'healthy',
                connected: this.client?.isConnected() || false,
                activeEscrows: this.escrows.size
            });
        });
    }

    async start() {
        const initialized = await this.initialize();
        if (!initialized) {
            throw new Error('Failed to initialize connection to the API');
        }

        this.app.listen(this.config.port, () => {
            console.log(`Cardano Escrow TEE Server running on port ${this.config.port}`);
            console.log(`Network: ${this.config.network}`);
            console.log(`Rescue delay: ${this.config.rescueDelay} seconds`);
        });
    }

    async stop() {
        if (this.client) {
            await this.client.disconnect();
        }
    }
}

// Export for use as module
module.exports = CardanoEscrowTEE;

// Run server if this file is executed directly
if (require.main === module) {
    const server = new CardanoEscrowTEE({
        //network: process.env.XRPL_NETWORK || 'wss://s.altnet.rippletest.net:51233',
        port: process.env.PORT || 3000,
        rescueDelay: parseInt(process.env.RESCUE_DELAY) || 60 * 30
    });

    server.start().catch(console.error);

    // Graceful shutdown
    process.on('SIGINT', async () => {
        console.log('Shutting down...');
        await server.stop();
        process.exit(0);
    });
}
