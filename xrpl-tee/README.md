# XRPL Trusted Execution Environment (TEE) Escrow Server

This TEE server replaces smart contract functionality on the XRPL side of cross-chain atomic swaps, providing hash-lock and time-lock capabilities equivalent to the EVM escrow contracts while generating a new wallet for each swap.

## Overview

The XRPL TEE server implements the destination chain escrow functionality from the cross-chain swap protocol, ensuring:

- **Wallet Isolation**: Each swap generates a fresh XRPL wallet
- **Hash-lock Security**: Funds can only be withdrawn with the correct secret
- **Time-lock Enforcement**: Strict timing windows for all operations
- **Atomic Guarantees**: Either both sides of the swap complete or both can be cancelled

## Architecture

```
EVM Chain (Source)          TEE Server (XRPL)         XRPL Network
┌─────────────────┐        ┌──────────────────┐      ┌─────────────────┐
│   EscrowSrc     │   →    │  XRPL TEE Server │  →   │  Generated      │
│   Contract      │        │                  │      │  Escrow Wallet  │
│                 │        │  - Hash-lock     │      │                 │
│  - hashlock     │        │  - Time-lock     │      │  - XRP/Tokens   │
│  - timelock     │        │  - Validation    │      │  - Isolated     │
│  - maker/taker  │        │  - Execution     │      │                 │
└─────────────────┘        └──────────────────┘      └─────────────────┘
```

## Features

### Core Functionality
- **Dynamic Wallet Generation**: Each escrow gets a unique XRPL wallet
- **Hash-lock Verification**: SHA3-256 hash validation matching Solidity keccak256
- **Time-lock Enforcement**: Seven distinct phases with precise timing
- **Cross-chain Compatibility**: Compatible with EVM escrow contracts
- **Emergency Recovery**: Rescue functions for stuck funds

### Security Features
- **Seed Isolation**: Wallet seeds stored separately from public data
- **Input Validation**: Comprehensive validation of all parameters
- **Time Window Enforcement**: Strict adherence to timelock periods
- **Caller Authentication**: Proper access control for all operations

### Operational Features
- **RESTful API**: Clean HTTP API for integration
- **Real-time Status**: Live escrow status monitoring
- **Transaction Verification**: On-chain verification of all operations
- **Graceful Error Handling**: Comprehensive error reporting

## Installation

### Prerequisites
- Node.js 16.0.0 or higher
- Access to XRPL network (testnet or mainnet)
- Sufficient XRP for transaction fees

### Setup
```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your configuration

# Start the server
npm start

# For development
npm run dev
```

## Configuration

### Environment Variables
```bash
# XRPL Network Configuration
XRPL_NETWORK=wss://s.altnet.rippletest.net:51233  # Testnet
# XRPL_NETWORK=wss://xrplcluster.com               # Mainnet

# Server Configuration
PORT=3000
RESCUE_DELAY=604800  # 7 days in seconds

# Security Configuration
RATE_LIMIT_WINDOW=900000  # 15 minutes
RATE_LIMIT_MAX=100        # requests per window
```

### Network Options
- **Testnet**: `wss://s.altnet.rippletest.net:51233`
- **Mainnet**: `wss://xrplcluster.com`
- **Custom**: Any XRPL node WebSocket URL

## API Reference

### Create Destination Escrow
```http
POST /escrow/create-dst
Content-Type: application/json

{
  "orderHash": "0x1234...",
  "hashlock": "0xabcd...",
  "maker": "rMaker123...",
  "taker": "rTaker456...", 
  "token": "0x0000000000000000000000000000000000000000",
  "amount": "1000000",
  "safetyDeposit": "100000",
  "timelocks": "0x...",
  "srcCancellationTimestamp": 1700000000
}
```

**Response:**
```json
{
  "escrowId": "uuid-v4",
  "walletAddress": "rEscrow789...",
  "requiredDeposit": {
    "xrp": "1100000",
    "token": "0"
  },
  "timelocks": {
    "4": 1700000100,
    "5": 1700000200,
    "6": 1700000300
  }
}
```

### Fund Escrow
```http
POST /escrow/{escrowId}/fund
Content-Type: application/json

{
  "fromAddress": "rFunder123...",
  "txHash": "ABCDEF123456..."
}
```

### Withdraw from Escrow
```http
POST /escrow/{escrowId}/withdraw
Content-Type: application/json

{
  "secret": "0x1234567890abcdef...",
  "callerAddress": "rCaller123...",
  "isPublic": false
}
```

### Cancel Escrow
```http
POST /escrow/{escrowId}/cancel
Content-Type: application/json

{
  "callerAddress": "rTaker456..."
}
```

### Get Escrow Status
```http
GET /escrow/{escrowId}
```

### Health Check
```http
GET /health
```

## Time-lock Phases

The TEE server enforces the same seven time-lock phases as the EVM contracts:

| Phase | Description | Who Can Call | When |
|-------|-------------|--------------|------|
| **0** | SrcWithdrawal | Taker | After withdrawal start |
| **1** | SrcPublicWithdrawal | Anyone with token | After public withdrawal start |
| **2** | SrcCancellation | Taker | After cancellation start |
| **3** | SrcPublicCancellation | Anyone with token | After public cancellation start |
| **4** | DstWithdrawal | Taker | After withdrawal start |
| **5** | DstPublicWithdrawal | Anyone with token | After public withdrawal start |
| **6** | DstCancellation | Taker | After cancellation start |

## Integration Example

### JavaScript Client
```javascript
const axios = require('axios');

class XRPLEscrowClient {
  constructor(baseUrl = 'http://localhost:3000') {
    this.baseUrl = baseUrl;
  }

  async createEscrow(escrowData) {
    const response = await axios.post(
      `${this.baseUrl}/escrow/create-dst`,
      escrowData
    );
    return response.data;
  }

  async fundEscrow(escrowId, fundingData) {
    const response = await axios.post(
      `${this.baseUrl}/escrow/${escrowId}/fund`,
      fundingData
    );
    return response.data;
  }

  async withdraw(escrowId, secret, callerAddress) {
    const response = await axios.post(
      `${this.baseUrl}/escrow/${escrowId}/withdraw`,
      { secret, callerAddress }
    );
    return response.data;
  }
}

// Usage
const client = new XRPLEscrowClient();
const escrow = await client.createEscrow({
  orderHash: '0x1234...',
  hashlock: '0xabcd...',
  // ... other parameters
});
```

### Complete Swap Flow
```javascript
// 1. Create destination escrow
const escrow = await teeClient.createEscrow(escrowParams);

// 2. Fund the generated wallet
await xrplClient.submitAndWait({
  TransactionType: 'Payment',
  Account: taker.address,
  Destination: escrow.walletAddress,
  Amount: escrow.requiredDeposit.xrp
});

// 3. Confirm funding
await teeClient.fundEscrow(escrow.escrowId, {
  fromAddress: taker.address,
  txHash: fundingTx.hash
});

// 4. Wait for source chain withdrawal (reveals secret)
const secret = await waitForSecretReveal(sourceEscrow);

// 5. Withdraw from destination escrow
await teeClient.withdraw(escrow.escrowId, secret, taker.address);
```

## Security Considerations

### Wallet Management
- Each escrow generates a unique wallet
- Private keys never leave the TEE
- Seeds are stored separately from escrow data
- Wallets are single-use only

### Hash-lock Validation
- Uses SHA3-256 (keccak256 equivalent)
- Secrets must be 32-byte hex strings
- Hash comparison is case-insensitive
- No partial secret matching

### Time-lock Enforcement
- All timestamps are Unix epoch seconds
- Time windows are strictly enforced
- No operations allowed outside valid periods
- Emergency rescue after 7-day delay

### Access Control
- Caller validation for all operations
- Role-based permissions (maker/taker)
- Public operations require access tokens
- Rate limiting on all endpoints

## Monitoring and Logging

### Health Monitoring
```bash
# Check server health
curl http://localhost:3000/health

# Response
{
  "status": "healthy",
  "connected": true,
  "activeEscrows": 5
}
```

### Logging
The server provides structured logging with:
- Request/response logging
- Error tracking
- XRPL transaction monitoring
- Escrow state changes

### Metrics
- Active escrow count
- Transaction success/failure rates
- Average response times
- Network connectivity status

## Troubleshooting

### Common Issues

**Connection Failed**
```bash
# Check XRPL network status
curl -X POST https://s.altnet.rippletest.net:51234 \
  -H "Content-Type: application/json" \
  -d '{"method": "server_info"}'
```

**Insufficient Funds**
- Ensure the funding transaction covers both amount and safety deposit
- Check that the transaction was sent to the correct escrow wallet
- Verify transaction confirmation on XRPL

**Time Window Errors**
- Check that current time is within the valid operation window
- Verify timelock parsing and calculation
- Ensure clock synchronization

**Secret Validation Errors**
- Confirm secret is a 32-byte hex string
- Verify hash calculation matches Solidity keccak256
- Check case sensitivity in hash comparison

## Development

### Running Tests
```bash
npm test
```

### Code Quality
```bash
npm run lint
npm run lint:fix
```

### Docker Support
```dockerfile
FROM node:16-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

## License

MIT License - see LICENSE file for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## Support

For issues and questions:
- GitHub Issues: [505sol/9inch/issues](https://github.com/505sol/9inch/issues)
- Documentation: This README and inline code comments 