import * as xrpl from 'xrpl';

/**
 * Creates an XRPL wallet from an Ethereum-format private key
 * @param ethPrivateKey - Ethereum private key (hex string with or without 0x prefix)
 * @returns XRPL wallet object with address, publicKey, privateKey, and seed
 * @throws Error if private key format is invalid
 */
export function createXRPLWalletFromEthKey(ethPrivateKey: string): xrpl.Wallet {
  // Remove 0x prefix if present and validate format
  const cleanPrivateKey = ethPrivateKey.startsWith('0x') 
    ? ethPrivateKey.slice(2) 
    : ethPrivateKey;

  if (!/^[0-9a-fA-F]{64}$/.test(cleanPrivateKey)) {
    throw new Error('Invalid private key format. Must be 64 hex characters.');
  }

  // Use the private key as entropy to generate XRPL wallet
  const entropy = Buffer.from(cleanPrivateKey, 'hex');

  return xrpl.Wallet.fromEntropy(entropy);
}

/**
 * Refuels an XRPL wallet using testnet faucet if balance is low
 * @param wallet - XRPL wallet to refuel
 * @param client - XRPL client instance (optional, will create one if not provided)
 * @param minBalance - Minimum balance in XRP to trigger refuel (default: 100 XRP)
 * @returns Promise that resolves when funding is complete or not needed
 * @throws Error if funding fails
 */
export async function refuelWalletFromFaucet(
  wallet: xrpl.Wallet, 
  client?: xrpl.Client,
  minBalance: number = 25
): Promise<void> {
  let xrplClient = client;
  let shouldDisconnect = false;

  try {
    // Create client if not provided
    if (!xrplClient) {
      xrplClient = new xrpl.Client('wss://s.altnet.rippletest.net:51233');
      await xrplClient.connect();
      shouldDisconnect = true;
    }

    // Check current balance
    try {
      const response = await xrplClient.request({
        command: "account_info",
        account: wallet.address,
        ledger_index: "validated"
      });
      
      const currentBalance = Number(xrpl.dropsToXrp(response.result.account_data.Balance));
      console.log(`Wallet ${wallet.address} current balance: ${currentBalance} XRP`);
      
      if (currentBalance >= minBalance) {
        console.log(`Wallet ${wallet.address} has sufficient balance, skipping funding`);
        return;
      }
    } catch (error) {
      // Account might not exist yet, proceed with funding
      console.log(`Wallet ${wallet.address} account not found, proceeding with funding`);
    }

    // Fund the wallet using testnet faucet
    console.log(`Funding wallet ${wallet.address} from testnet faucet...`);
    await xrplClient.fundWallet(wallet);
    console.log(`Successfully funded wallet ${wallet.address}`);
  } catch (error) {
    throw new Error(`Failed to fund wallet ${wallet.address}: ${error}`);
  } finally {
    // Disconnect if we created the client
    if (shouldDisconnect && xrplClient) {
      await xrplClient.disconnect();
    }
  }
}

/**
 * Sends XRP from one wallet to an address
 * @param fromWallet - Source wallet to send from
 * @param toAddress - Destination address to send to
 * @param amount - Amount of XRP to send (as string or number)
 * @param client - XRPL client instance (optional, will create one if not provided)
 * @returns Promise that resolves with transaction hash when payment is complete
 * @throws Error if payment fails
 */
export async function sendXRP(
  fromWallet: xrpl.Wallet,
  toAddress: string,
  amount: string | number,
  client?: xrpl.Client
): Promise<string> {
  let xrplClient = client;
  let shouldDisconnect = false;

  try {
    // Create client if not provided
    if (!xrplClient) {
      xrplClient = new xrpl.Client('wss://s.altnet.rippletest.net:51233');
      await xrplClient.connect();
      shouldDisconnect = true;
    }

    // Convert amount to string if it's a number
    const amountStr = typeof amount === 'number' ? amount.toString() : amount;

    // Create payment transaction
    const payment: xrpl.Payment = {
      TransactionType: 'Payment',
      Account: fromWallet.address,
      Destination: toAddress,
      Amount: amountStr
    };

    console.log(`Sending ${amountStr} XRP from ${fromWallet.address} to ${toAddress}...`);

    // Submit and wait for transaction
    const response = await xrplClient.submitAndWait(payment, { wallet: fromWallet });
    
    if (response.result.validated && response.result.meta && typeof response.result.meta === 'object' && 'TransactionResult' in response.result.meta) {
      if (response.result.meta.TransactionResult === 'tesSUCCESS') {
        console.log(`Successfully sent ${amountStr} XRP drops. Transaction hash: ${response.result.hash}`);
        return response.result.hash;
      } else {
        throw new Error(`Transaction failed: ${response.result.meta.TransactionResult}`);
      }
    } else {
      throw new Error(`Transaction validation failed or incomplete response`);
    }
  } catch (error) {
    throw new Error(`Failed to send XRP from ${fromWallet.address} to ${toAddress}: ${error}`);
  } finally {
    // Disconnect if we created the client
    if (shouldDisconnect && xrplClient) {
      await xrplClient.disconnect();
    }
  }
}

