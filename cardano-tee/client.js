const axios = require('axios');
const crypto = require('crypto');

/**
 * Client library for interacting with the XRPL TEE Escrow Server
 */
class CardanoEscrowClient {
    constructor(config = {}) {
        this.baseUrl = config.baseUrl || 'https://tee.5050sol.space/health';
        this.timeout = config.timeout || 30000;
        this.retries = config.retries || 3;
        
        // Create axios instance with default config
        this.http = axios.create({
            baseURL: this.baseUrl,
            timeout: this.timeout,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Cardano-Escrow-Client/1.0.0'
            }
        });

        // Add request/response interceptors for logging and retries
        this.setupInterceptors();
    }

    setupInterceptors() {
        // Request interceptor for logging
        this.http.interceptors.request.use(
            (config) => {
                console.log(`→ ${config.method?.toUpperCase()} ${config.url}`);
                return config;
            },
            (error) => Promise.reject(error)
        );

        // Response interceptor for logging and error handling
        this.http.interceptors.response.use(
            (response) => {
                console.log(`← ${response.status} ${response.config.method?.toUpperCase()} ${response.config.url}`);
                return response;
            },
            async (error) => {
                const { config, response } = error;
                
                // Log error
                console.error(`✗ ${response?.status || 'NETWORK_ERROR'} ${config?.method?.toUpperCase()} ${config?.url}:`, 
                    response?.data?.error || error.message);

                // Retry logic for network errors and 5xx errors
                if (this.shouldRetry(error) && config && !config.__retryCount) {
                    config.__retryCount = 0;
                }

                if (config && config.__retryCount < this.retries && this.shouldRetry(error)) {
                    config.__retryCount += 1;
                    console.log(`Retrying request (${config.__retryCount}/${this.retries})...`);
                    
                    // Exponential backoff
                    const delay = Math.pow(2, config.__retryCount) * 1000;
                    await new Promise(resolve => setTimeout(resolve, delay));
                    
                    return this.http(config);
                }

                return Promise.reject(error);
            }
        );
    }

    shouldRetry(error) {
        return (
            !error.response || // Network error
            error.response.status >= 500 || // Server error
            error.response.status === 429 // Rate limited
        );
    }

    /**
     * Generate a cryptographically secure secret
     * @returns {string} 32-byte hex string
     */
    static generateSecret() {
        return '0x' + crypto.randomBytes(32).toString('hex');
    }

    /**
     * Hash a secret using SHA3-256 (equivalent to Solidity keccak256)
     * @param {string} secret - 32-byte hex string
     * @returns {string} Hash of the secret
     */
    static hashSecret(secret) {
        const secretBytes = Buffer.from(secret.replace('0x', ''), 'hex');
        return '0x' + crypto.createHash('sha3-256').update(secretBytes).digest('hex');
    }

    /**
     * Create a new destination escrow
     * @param {Object} escrowData - Escrow parameters
     * @returns {Promise<Object>} Escrow creation response
     */
    async createDestinationEscrow(escrowData) {
        try {
            const response = await this.http.post('/escrow/create-dst', escrowData);
            return response.data;
        } catch (error) {
            throw this.formatError('Failed to create destination escrow', error);
        }
    }

    /**
     * Fund an escrow with a transaction
     * @param {string} escrowId - Escrow ID
     * @param {Object} fundingData - Funding transaction details
     * @returns {Promise<Object>} Funding confirmation
     */
    async fundEscrow(escrowId, fundingData) {
        try {
            const response = await this.http.post(`/escrow/${escrowId}/fund`, fundingData);
            return response.data;
        } catch (error) {
            throw this.formatError('Failed to fund escrow', error);
        }
    }

    /**
     * Withdraw funds from an escrow
     * @param {string} escrowId - Escrow ID
     * @param {string} secret - Secret that unlocks the escrow
     * @param {string} callerAddress - Address of the caller
     * @param {boolean} isPublic - Whether this is a public withdrawal
     * @returns {Promise<Object>} Withdrawal result
     */
    async withdraw(escrowId, secret, callerAddress, isPublic = false) {
        try {
            const response = await this.http.post(`/escrow/${escrowId}/withdraw`, {
                secret,
                callerAddress,
                isPublic
            });
            return response.data;
        } catch (error) {
            throw this.formatError('Failed to withdraw from escrow', error);
        }
    }

    /**
     * Cancel an escrow and return funds
     * @param {string} escrowId - Escrow ID  
     * @param {string} callerAddress - Address of the caller
     * @returns {Promise<Object>} Cancellation result
     */
    async cancel(escrowId, callerAddress) {
        try {
            const response = await this.http.post(`/escrow/${escrowId}/cancel`, {
                callerAddress
            });
            return response.data;
        } catch (error) {
            throw this.formatError('Failed to cancel escrow', error);
        }
    }

    /**
     * Rescue funds from an escrow (emergency function)
     * @param {string} escrowId - Escrow ID
     * @param {string} callerAddress - Address of the caller
     * @param {string} amount - Amount to rescue
     * @returns {Promise<Object>} Rescue result
     */
    async rescueFunds(escrowId, callerAddress, amount) {
        try {
            const response = await this.http.post(`/escrow/${escrowId}/rescue`, {
                callerAddress,
                amount
            });
            return response.data;
        } catch (error) {
            throw this.formatError('Failed to rescue funds', error);
        }
    }

    /**
     * Get escrow status and details
     * @param {string} escrowId - Escrow ID
     * @returns {Promise<Object>} Escrow details
     */
    async getEscrow(escrowId) {
        try {
            const response = await this.http.get(`/escrow/${escrowId}`);
            return response.data;
        } catch (error) {
            throw this.formatError('Failed to get escrow details', error);
        }
    }

    /**
     * Check server health and connectivity
     * @returns {Promise<Object>} Health status
     */
    async getHealth() {
        try {
            const response = await this.http.get('/health');
            return response.data;
        } catch (error) {
            throw this.formatError('Failed to check server health', error);
        }
    }

    /**
     * Wait for escrow to reach a specific status
     * @param {string} escrowId - Escrow ID
     * @param {string} targetStatus - Target status to wait for
     * @param {number} timeout - Timeout in milliseconds
     * @param {number} interval - Polling interval in milliseconds
     * @returns {Promise<Object>} Escrow details when target status is reached
     */
    async waitForStatus(escrowId, targetStatus, timeout = 300000, interval = 2000) {
        const startTime = Date.now();
        
        while (Date.now() - startTime < timeout) {
            try {
                const escrow = await this.getEscrow(escrowId);
                if (escrow.status === targetStatus) {
                    return escrow;
                }
                
                console.log(`Waiting for escrow ${escrowId} to reach status "${targetStatus}". Current: "${escrow.status}"`);
                await new Promise(resolve => setTimeout(resolve, interval));
            } catch (error) {
                if (error.response?.status === 404) {
                    throw new Error(`Escrow ${escrowId} not found`);
                }
                // Continue polling on other errors
                console.warn(`Error checking escrow status: ${error.message}`);
                await new Promise(resolve => setTimeout(resolve, interval));
            }
        }
        
        throw new Error(`Timeout waiting for escrow ${escrowId} to reach status "${targetStatus}"`);
    }

    /**
     * Complete escrow workflow with validation
     * @param {Object} escrowParams - Initial escrow parameters
     * @param {Object} fundingTx - Funding transaction details
     * @param {string} secret - Secret for withdrawal
     * @param {string} callerAddress - Caller address
     * @returns {Promise<Object>} Complete workflow results
     */
    async completeEscrowWorkflow(escrowParams, fundingTx, secret, callerAddress) {
        const workflow = {
            escrow: null,
            funding: null,
            withdrawal: null,
            status: 'started'
        };

        try {
            // Step 1: Create escrow
            console.log('Creating destination escrow...');
            workflow.escrow = await this.createDestinationEscrow(escrowParams);
            workflow.status = 'created';

            // Step 2: Fund escrow
            console.log('Funding escrow...');
            workflow.funding = await this.fundEscrow(workflow.escrow.escrowId, fundingTx);
            workflow.status = 'funded';

            // Step 3: Wait for withdrawal window
            const escrow = await this.waitForStatus(workflow.escrow.escrowId, 'funded');
            const now = Math.floor(Date.now() / 1000);
            const withdrawalTime = escrow.timelocks[4]; // DstWithdrawal

            if (now < withdrawalTime) {
                const waitTime = (withdrawalTime - now) * 1000;
                console.log(`Waiting ${waitTime / 1000} seconds for withdrawal window...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }

            // Step 4: Withdraw
            console.log('Withdrawing from escrow...');
            workflow.withdrawal = await this.withdraw(
                workflow.escrow.escrowId,
                secret,
                callerAddress
            );
            workflow.status = 'completed';

            return workflow;

        } catch (error) {
            workflow.status = 'failed';
            workflow.error = error.message;
            throw error;
        }
    }

    /**
     * Format error with additional context
     * @param {string} message - Error message
     * @param {Error} error - Original error
     * @returns {Error} Formatted error
     */
    formatError(message, error) {
        const err = new Error(message);
        err.originalError = error;
        err.response = error.response?.data;
        err.status = error.response?.status;
        return err;
    }
}

/**
 * Utility functions for Cardano escrow operations
 */
class CardanoEscrowUtils {
    /**
     * Pack timelocks into uint256 format (similar to Solidity implementation)
     * @param {Object} timelocks - Timelock values
     * @param {number} deployedAt - Deployment timestamp
     * @returns {string} Packed timelocks as hex string
     */
    static packTimelocks(timelocks, deployedAt) {
        let packed = BigInt(deployedAt) << 224n;
        
        for (let stage = 0; stage < 7; stage++) {
            if (timelocks[stage] !== undefined) {
                const offset = BigInt(timelocks[stage] - deployedAt);
                packed |= offset << BigInt(stage * 32);
            }
        }
        
        return '0x' + packed.toString(16);
    }

    /**
     * Unpack timelocks from uint256 format
     * @param {string} packedTimelocks - Packed timelocks hex string
     * @returns {Object} Unpacked timelock values
     */
    static unpackTimelocks(packedTimelocks) {
        const data = BigInt(packedTimelocks);
        const deployedAt = Number((data >> 224n) & 0xFFFFFFFFn);
        const timelocks = { deployedAt };
        
        for (let stage = 0; stage < 7; stage++) {
            const bitShift = BigInt(stage * 32);
            const stageOffset = Number((data >> bitShift) & 0xFFFFFFFFn);
            timelocks[stage] = deployedAt + stageOffset;
        }
        
        return timelocks;
    }

    /**
     * Calculate required deposits for escrow
     * @param {string} token - Token address (0x0 for native XRP)
     * @param {string} amount - Escrow amount
     * @param {string} safetyDeposit - Safety deposit amount
     * @returns {Object} Required deposit breakdown
     */
    static calculateDeposits(token, amount, safetyDeposit) {
        const isNativeXRP = token === '0x0000000000000000000000000000000000000000';
        
        return {
            xrp: isNativeXRP ? 
                (BigInt(amount) + BigInt(safetyDeposit)).toString() : 
                safetyDeposit,
            token: isNativeXRP ? '0' : amount,
            total: (BigInt(amount) + BigInt(safetyDeposit)).toString()
        };
    }

    /**
     * Validate escrow parameters
     * @param {Object} params - Escrow parameters
     * @throws {Error} If parameters are invalid
     */
    static validateEscrowParams(params) {
        const required = [
            'orderHash', 'hashlock', 'maker', 'taker', 
            'token', 'amount', 'safetyDeposit', 'timelocks'
        ];

        for (const field of required) {
            if (!params[field]) {
                throw new Error(`Missing required parameter: ${field}`);
            }
        }

        // Validate hex strings
        if (!params.orderHash.match(/^0x[0-9a-fA-F]{64}$/)) {
            throw new Error('Invalid orderHash format');
        }

        if (!params.hashlock.match(/^0x[0-9a-fA-F]{64}$/)) {
            throw new Error('Invalid hashlock format');
        }

        // Validate addresses
        if (!params.maker.match(/^r[0-9a-zA-Z]{24,34}$/)) {
            throw new Error('Invalid maker XRPL address');
        }

        if (!params.taker.match(/^r[0-9a-zA-Z]{24,34}$/)) {
            throw new Error('Invalid taker XRPL address');
        }

        // Validate amounts
        if (BigInt(params.amount) <= 0) {
            throw new Error('Amount must be positive');
        }

        if (BigInt(params.safetyDeposit) < 0) {
            throw new Error('Safety deposit cannot be negative');
        }
    }
}

module.exports = {
    XRPLEscrowClient,
    XRPLEscrowUtils
}; 