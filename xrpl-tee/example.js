const xrpl = require('xrpl');
const { XRPLEscrowClient, XRPLEscrowUtils } = require('./client.js');

/**
 * Example: Complete Cross-Chain Atomic Swap Flow
 * 
 * This example demonstrates the complete flow for a cross-chain atomic swap
 * between an EVM chain (source) and XRPL (destination) using the TEE server.
 */

// Configuration
const config = {
    // TEE Server
    teeServerUrl: 'http://localhost:3000',
    
    // XRPL Configuration
    xrplNetwork: 'wss://s.altnet.rippletest.net:51233', // Testnet
    
    // Example participants
    maker: {
        evmAddress: '0x742b...',
        xrplAddress: 'rMaker123...',
        // EVM wallet would be used for source chain operations
    },
    taker: {
        evmAddress: '0x863c...',
        xrplAddress: 'rTaker456...',
        xrplWallet: null // Will be set from seed
    },
    
    // Swap parameters
    swap: {
        amount: '1000000000', // 1 XRP in drops
        safetyDeposit: '100000000', // 0.1 XRP in drops
        token: '0x0000000000000000000000000000000000000000', // Native XRP
        orderHash: '0x' + '1'.repeat(64), // Example order hash from EVM side
    }
};

async function runCompleteSwapExample() {
    console.log('🚀 Starting Cross-Chain Atomic Swap Example');
    console.log('=====================================\n');

    // Initialize clients
    const teeClient = new XRPLEscrowClient({ baseUrl: config.teeServerUrl });
    const xrplClient = new xrpl.Client(config.xrplNetwork);
    await xrplClient.connect();

    // Fund taker wallet for testing (testnet only)
    if (config.xrplNetwork.includes('altnet')) {
        console.log('💰 Funding taker wallet for testnet...');
        await xrplClient.fundWallet();
        config.taker.xrplWallet = (await xrplClient.fundWallet()).wallet;
    } else {
        throw new Error('This example requires a funded wallet for mainnet');
    }

    console.log(`Taker XRPL Address: ${config.taker.xrplWallet.address}\n`);

    try {
        // Phase 1: Generate secret and create hash-lock
        console.log('📝 Phase 1: Creating Hash-lock');
        console.log('--------------------------------');
        
        const secret = XRPLEscrowClient.generateSecret();
        const hashlock = XRPLEscrowClient.hashSecret(secret);
        
        console.log(`Secret: ${secret}`);
        console.log(`Hashlock: ${hashlock}\n`);

        // Phase 2: Set up timelocks (times in seconds from now)
        console.log('⏰ Phase 2: Setting up Time-locks');
        console.log('--------------------------------');
        
        const now = Math.floor(Date.now() / 1000);
        const timelocks = {
            // Source chain phases (would be handled by EVM contracts)
            0: now + 300,   // SrcWithdrawal: 5 minutes
            1: now + 600,   // SrcPublicWithdrawal: 10 minutes  
            2: now + 1800,  // SrcCancellation: 30 minutes
            3: now + 2400,  // SrcPublicCancellation: 40 minutes
            
            // Destination chain phases (handled by TEE)
            4: now + 120,   // DstWithdrawal: 2 minutes
            5: now + 480,   // DstPublicWithdrawal: 8 minutes
            6: now + 1200,  // DstCancellation: 20 minutes
        };

        console.log('Timelock schedule:');
        Object.entries(timelocks).forEach(([stage, time]) => {
            const stageName = [
                'SrcWithdrawal', 'SrcPublicWithdrawal', 'SrcCancellation', 'SrcPublicCancellation',
                'DstWithdrawal', 'DstPublicWithdrawal', 'DstCancellation'
            ][stage];
            console.log(`  ${stageName}: ${new Date(time * 1000).toLocaleTimeString()}`);
        });

        const packedTimelocks = XRPLEscrowUtils.packTimelocks(timelocks, now);
        console.log(`Packed timelocks: ${packedTimelocks}\n`);

        // Phase 3: Create destination escrow on XRPL via TEE
        console.log('🏗️  Phase 3: Creating Destination Escrow');
        console.log('---------------------------------------');
        
        const escrowParams = {
            orderHash: config.swap.orderHash,
            hashlock: hashlock,
            maker: config.maker.xrplAddress,
            taker: config.taker.xrplAddress,
            token: config.swap.token,
            amount: config.swap.amount,
            safetyDeposit: config.swap.safetyDeposit,
            timelocks: packedTimelocks,
            srcCancellationTimestamp: timelocks[2] // Source cancellation time
        };

        // Validate parameters
        XRPLEscrowUtils.validateEscrowParams(escrowParams);
        
        const escrow = await teeClient.createDestinationEscrow(escrowParams);
        console.log(`✅ Escrow created with ID: ${escrow.escrowId}`);
        console.log(`📍 Escrow wallet address: ${escrow.walletAddress}`);
        console.log(`💰 Required deposit: ${escrow.requiredDeposit.xrp} drops\n`);

        // Phase 4: Fund the escrow wallet
        console.log('💸 Phase 4: Funding Escrow Wallet');
        console.log('--------------------------------');
        
        const fundingTx = {
            TransactionType: 'Payment',
            Account: config.taker.xrplWallet.address,
            Destination: escrow.walletAddress,
            Amount: escrow.requiredDeposit.xrp
        };

        const prepared = await xrplClient.autofill(fundingTx);
        const signed = config.taker.xrplWallet.sign(prepared);
        const fundingResult = await xrplClient.submitAndWait(signed.tx_blob);

        if (fundingResult.result.meta.TransactionResult === 'tesSUCCESS') {
            console.log(`✅ Funding transaction successful: ${fundingResult.result.hash}`);
            
            // Confirm funding with TEE
            await teeClient.fundEscrow(escrow.escrowId, {
                fromAddress: config.taker.xrplWallet.address,
                txHash: fundingResult.result.hash
            });
            console.log('✅ Funding confirmed by TEE\n');
        } else {
            throw new Error(`Funding failed: ${fundingResult.result.meta.TransactionResult}`);
        }

        // Phase 5: Wait for withdrawal window and simulate source chain activity
        console.log('⏳ Phase 5: Waiting for Withdrawal Window');
        console.log('----------------------------------------');
        
        const withdrawalTime = timelocks[4];
        const waitTime = Math.max(0, withdrawalTime - Math.floor(Date.now() / 1000));
        
        if (waitTime > 0) {
            console.log(`Waiting ${waitTime} seconds for withdrawal window to open...`);
            console.log('(In real scenario, the source chain withdrawal would happen here,');
            console.log(' revealing the secret, which would then be used for destination withdrawal)\n');
            
            // Simulate waiting
            await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
        }

        // Phase 6: Withdraw from destination escrow
        console.log('🎯 Phase 6: Withdrawing from Destination Escrow');
        console.log('----------------------------------------------');
        
        const withdrawResult = await teeClient.withdraw(
            escrow.escrowId,
            secret,
            config.taker.xrplWallet.address
        );

        console.log(`✅ Withdrawal successful!`);
        console.log(`📝 Transaction hash: ${withdrawResult.txHash}`);
        console.log(`💰 Amount withdrawn: ${withdrawResult.amount} drops`);
        console.log(`🔐 Secret revealed: ${withdrawResult.secret}\n`);

        // Phase 7: Verify final state
        console.log('🔍 Phase 7: Verifying Final State');
        console.log('--------------------------------');
        
        const finalEscrow = await teeClient.getEscrow(escrow.escrowId);
        console.log(`Final escrow status: ${finalEscrow.status}`);
        
        // Check maker's balance increased (destination chain)
        const makerAccount = await xrplClient.request({
            command: 'account_info',
            account: config.maker.xrplAddress
        });
        console.log(`Maker received funds on XRPL destination chain`);
        
        console.log('\n🎉 Cross-Chain Atomic Swap Completed Successfully!');
        console.log('The secret has been revealed and both chains have settled.');

    } catch (error) {
        console.error('\n❌ Swap failed:', error.message);
        
        // In a real scenario, you might want to attempt cancellation
        if (error.escrowId) {
            console.log('\n🔄 Attempting to cancel escrow...');
            try {
                await teeClient.cancel(error.escrowId, config.taker.xrplWallet.address);
                console.log('✅ Escrow cancelled, funds returned');
            } catch (cancelError) {
                console.error('❌ Cancellation also failed:', cancelError.message);
            }
        }
    } finally {
        await xrplClient.disconnect();
    }
}

/**
 * Example: Testing Hash-lock functionality
 */
async function testHashLockExample() {
    console.log('\n🔒 Testing Hash-lock Functionality');
    console.log('=================================');
    
    // Generate secret and hash
    const secret1 = XRPLEscrowClient.generateSecret();
    const hash1 = XRPLEscrowClient.hashSecret(secret1);
    
    console.log(`Secret: ${secret1}`);
    console.log(`Hash:   ${hash1}`);
    
    // Verify hash matches
    const hash1_verify = XRPLEscrowClient.hashSecret(secret1);
    console.log(`Hash verification: ${hash1 === hash1_verify ? '✅ PASS' : '❌ FAIL'}`);
    
    // Test with different secret
    const secret2 = XRPLEscrowClient.generateSecret();
    const hash2 = XRPLEscrowClient.hashSecret(secret2);
    console.log(`Different hash: ${hash2 !== hash1 ? '✅ PASS' : '❌ FAIL'}`);
}

/**
 * Example: Testing Time-lock functionality
 */
async function testTimeLockExample() {
    console.log('\n⏰ Testing Time-lock Functionality');
    console.log('=================================');
    
    const now = Math.floor(Date.now() / 1000);
    const timelocks = {
        0: now + 60,    // 1 minute
        1: now + 120,   // 2 minutes
        2: now + 180,   // 3 minutes
        3: now + 240,   // 4 minutes
        4: now + 300,   // 5 minutes
        5: now + 360,   // 6 minutes
        6: now + 420,   // 7 minutes
    };
    
    console.log('Original timelock structure:');
    console.log(timelocks);
    
    // Pack and unpack
    const packed = XRPLEscrowUtils.packTimelocks(timelocks, now);
    const unpacked = XRPLEscrowUtils.unpackTimelocks(packed);
    
    console.log(`\nPacked: ${packed}`);
    console.log('Unpacked timelock structure:');
    console.log(unpacked);
    
    // Verify they match
    let matches = true;
    for (let i = 0; i < 7; i++) {
        if (timelocks[i] !== unpacked[i]) {
            matches = false;
            break;
        }
    }
    
    console.log(`Pack/unpack verification: ${matches ? '✅ PASS' : '❌ FAIL'}`);
}

/**
 * Example: Health monitoring
 */
async function monitoringExample() {
    console.log('\n📊 Health Monitoring Example');
    console.log('============================');
    
    const client = new XRPLEscrowClient({ baseUrl: config.teeServerUrl });
    
    try {
        const health = await client.getHealth();
        console.log('Server health status:');
        console.log(JSON.stringify(health, null, 2));
    } catch (error) {
        console.error('❌ Health check failed:', error.message);
    }
}

// Main execution
async function main() {
    console.log('XRPL TEE Escrow Server - Complete Examples');
    console.log('==========================================\n');
    
    try {
        // Run individual tests
        await testHashLockExample();
        await testTimeLockExample();
        await monitoringExample();
        
        // Run complete swap example
        console.log('\n' + '='.repeat(50));
        await runCompleteSwapExample();
        
    } catch (error) {
        console.error('\n💥 Example execution failed:', error);
    }
}

// Run examples if this file is executed directly
if (require.main === module) {
    main().catch(console.error);
}

module.exports = {
    runCompleteSwapExample,
    testHashLockExample,
    testTimeLockExample,
    monitoringExample,
    config
}; 