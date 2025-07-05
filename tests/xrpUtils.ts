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
 * Refuels an XRPL wallet using testnet faucet
 * @param wallet - XRPL wallet to refuel
 * @param client - XRPL client instance (optional, will create one if not provided)
 * @returns Promise that resolves when funding is complete
 * @throws Error if funding fails
 */
export async function refuelWalletFromFaucet(
  wallet: xrpl.Wallet, 
  client?: xrpl.Client
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

