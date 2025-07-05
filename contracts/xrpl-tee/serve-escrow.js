const xrpl = require('xrpl');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');

class XRPLEscrowTEE {
    constructor(config = {}) {
        this.client = null;
        this.config = {
            network: config.network || 'wss://s.altnet.rippletest.net:51233', // testnet by default
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
        try {
            this.client = new xrpl.Client(this.config.network);
            await this.client.connect();
            console.log(`Connected to XRPL ${this.config.network}`);
            return true;
        } catch (error) {
            console.error('Failed to connect to XRPL:', error);
            return false;
        }
    }

    // Generate a new wallet for each escrow swap
    generateEscrowWallet() {
        const wallet = xrpl.Wallet.generate();
        return {
            address: wallet.address,
            seed: wallet.seed,
            privateKey: wallet.privateKey,
            publicKey: wallet.publicKey
        };
    }

    // Hash function equivalent to Solidity keccak256
    keccak256(data) {
        return crypto.createHash('sha3-256').update(data).digest('hex');
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
    validateTimeWindow(escrow, stage, requireBefore = null) {
        const now = Math.floor(Date.now() / 1000);
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
        const secretHash = this.keccak256(Buffer.from(secret.replace('0x', ''), 'hex'));
        if ('0x' + secretHash !== hashlock.toLowerCase()) {
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
                    srcCancellationTimestamp
                } = req.body;

                // Generate new wallet for this escrow
                const escrowWallet = this.generateEscrowWallet();
                const deployedAt = Math.floor(Date.now() / 1000);
                const parsedTimelocks = this.parseTimelocks(timelocks, deployedAt);
                
                // Validate cancellation timing
                if (parsedTimelocks[this.TimeStages.DstCancellation] > srcCancellationTimestamp) {
                    return res.status(400).json({ 
                        error: 'Destination cancellation time must not exceed source cancellation time' 
                    });
                }

                const escrowId = crypto.randomUUID();
                const escrow = {
                    id: escrowId,
                    orderHash,
                    hashlock: hashlock.toLowerCase(),
                    maker: maker.toLowerCase(),
                    taker: taker.toLowerCase(),
                    token: token.toLowerCase(),
                    amount: BigInt(amount),
                    safetyDeposit: BigInt(safetyDeposit),
                    timelocks: parsedTimelocks,
                    deployedAt,
                    wallet: {
                        address: escrowWallet.address,
                        publicKey: escrowWallet.publicKey
                    },
                    status: 'created',
                    type: 'destination'
                };

                // Store escrow and wallet seed securely
                this.escrows.set(escrowId, escrow);
                this.walletSeeds.set(escrowId, escrowWallet.seed);

                res.json({
                    escrowId,
                    walletAddress: escrowWallet.address,
                    requiredDeposit: {
                        xrp: token === '0x0000000000000000000000000000000000000000' ? 
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

        // Fund the escrow wallet
        this.app.post('/escrow/:escrowId/fund', async (req, res) => {
            try {
                const { escrowId } = req.params;
                const { fromAddress, txHash } = req.body;

                const escrow = this.escrows.get(escrowId);
                if (!escrow) {
                    return res.status(404).json({ error: 'Escrow not found' });
                }

                // Verify the funding transaction
                const tx = await this.client.request({
                    command: 'tx',
                    transaction: txHash
                });

                if (tx.result.TransactionType !== 'Payment') {
                    return res.status(400).json({ error: 'Invalid transaction type' });
                }

                if (tx.result.Destination !== escrow.wallet.address) {
                    return res.status(400).json({ error: 'Payment not sent to escrow address' });
                }

                const amountReceived = BigInt(tx.result.Amount);
                const requiredAmount = escrow.token === '0x0000000000000000000000000000000000000000' ?
                    escrow.amount + escrow.safetyDeposit :
                    escrow.safetyDeposit;

                if (amountReceived < requiredAmount) {
                    return res.status(400).json({ 
                        error: `Insufficient funding. Required: ${requiredAmount}, Received: ${amountReceived}` 
                    });
                }

                escrow.status = 'funded';
                escrow.fundingTx = txHash;

                res.json({ 
                    message: 'Escrow successfully funded',
                    escrowId,
                    amountReceived: amountReceived.toString()
                });

            } catch (error) {
                console.error('Error funding escrow:', error);
                res.status(500).json({ error: error.message });
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
                    if (callerAddress.toLowerCase() !== escrow.taker) {
                        return res.status(403).json({ error: 'Only taker can withdraw during private period' });
                    }
                    this.validateTimeWindow(
                        escrow, 
                        this.TimeStages.DstWithdrawal,
                        this.TimeStages.DstCancellation
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
                const wallet = xrpl.Wallet.fromSeed(walletSeed);

                const payment = {
                    TransactionType: 'Payment',
                    Account: wallet.address,
                    Destination: escrow.maker,
                    Amount: escrow.amount.toString()
                };

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

                // Validate caller and timing
                if (callerAddress.toLowerCase() !== escrow.taker) {
                    return res.status(403).json({ error: 'Only taker can cancel' });
                }

                this.validateTimeWindow(escrow, this.TimeStages.DstCancellation);

                // Execute cancellation - return funds to taker
                const walletSeed = this.walletSeeds.get(escrowId);
                const wallet = xrpl.Wallet.fromSeed(walletSeed);

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
                    escrow.status = 'cancelled';
                    escrow.cancelTx = result.result.hash;

                    res.json({
                        message: 'Escrow cancelled successfully',
                        txHash: result.result.hash,
                        refundAmount: (escrow.amount + escrow.safetyDeposit).toString()
                    });
                } else {
                    throw new Error(`Transaction failed: ${result.result.meta.TransactionResult}`);
                }

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
                if (callerAddress.toLowerCase() !== escrow.taker) {
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
                const wallet = xrpl.Wallet.fromSeed(walletSeed);

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
            throw new Error('Failed to initialize XRPL connection');
        }

        this.app.listen(this.config.port, () => {
            console.log(`XRPL Escrow TEE Server running on port ${this.config.port}`);
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
module.exports = XRPLEscrowTEE;

// Run server if this file is executed directly
if (require.main === module) {
    const server = new XRPLEscrowTEE({
        network: process.env.XRPL_NETWORK || 'wss://s.altnet.rippletest.net:51233',
        port: process.env.PORT || 3000,
        rescueDelay: parseInt(process.env.RESCUE_DELAY) || 86400 * 7
    });

    server.start().catch(console.error);

    // Graceful shutdown
    process.on('SIGINT', async () => {
        console.log('Shutting down...');
        await server.stop();
        process.exit(0);
    });
}
