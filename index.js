require('dotenv').config();

const express = require('express');
const fetch = require('node-fetch');
const bip39 = require('bip39');
const { BIP32Factory } = require('bip32');
const bitcoin = require('bitcoinjs-lib');
const TronWeb = require('tronweb');
const fs = require('fs');
const ecc = require('tiny-secp256k1');
const { ECPairFactory } = require('ecpair');
const { ethers } = require('ethers');
const crypto = require('crypto');
const { Connection, LAMPORTS_PER_SOL, Keypair } = require('@solana/web3.js');
const nacl = require('tweetnacl');
const { TonClient, WalletContractV4, Address } = require('@ton/ton');
const { mnemonicToWalletKey } = require('@ton/crypto');
const bs58 = require('bs58');
const { MongoClient } = require('mongodb');

const app = express();
const port = process.env.PORT || 9374;

const bip32 = BIP32Factory(ecc);
const ECPair = ECPairFactory(ecc);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ... [The rest of the bot logic from worker.js will be pasted here] ...

const networks = {
    bitcoin: {
        lib: bitcoin.networks.bitcoin,
        path: "m/44'/0'/0'/0/0",
        decimals: 8
    },
    ethereum: {
        path: "m/44'/60'/0'/0/0",
        tokens: {
            usdt: {
                address: '0xdac17f958d2ee523a2206206994597c13d831ec7',
                decimals: 6
            }
        },
        decimals: 18
    },
    solana: {
        path: "m/44'/501'/0'/0'",
        decimals: 9
    },
    ton: {
        path: "m/44'/607'/0'/0'",
        decimals: 9
    }
};

const apiProviders = {
    ethereum: [
        { name: 'etherscan', baseURL: 'https://api.etherscan.io/v2/api?chainid=1&module=account&action=balance&address={address}&tag=latest', apiKey: process.env.ETHERSCAN_API_KEY, responsePath: 'result' }
    ],
    bitcoin: [
        { name: 'blockstream', baseURL: 'https://blockstream.info/api/address/{address}', responsePath: 'chain_stats' },
        { name: 'blockchain_info', baseURL: 'https://blockchain.info/q/addressbalance/{address}', isText: true },
        { name: 'btc_com', baseURL: 'https://chain.api.btc.com/v3/address/{address}', responsePath: 'data.balance' },
        { name: 'blockcypher', baseURL: 'https://api.blockcypher.com/v1/btc/main/addrs/{address}/balance', responsePath: 'final_balance' },
        { name: 'mempool_space', baseURL: 'https://mempool.space/api/address/{address}', responsePath: 'chain_stats' }
    ],
    tron: [
        { name: 'trongrid', baseURL: 'https://api.trongrid.io/v1/accounts/{address}', responsePath: 'data[0].balance' }
    ],
    solana: [
        { name: 'solana', baseURL: 'https://api.mainnet-beta.solana.com', method: 'getBalance', responsePath: 'value' }
    ],
    ton: [
        { name: 'toncenter', baseURL: 'https://toncenter.com/api/v2/jsonRPC', apiKey: process.env.TONCENTER_API_KEY }
    ] // TON balance check not supported yet
};

async function deriveAddress(currency, { seed, root, mnemonic }) {
    const network = networks[currency];
    switch (currency) {
        case 'bitcoin': {
            const child = root.derivePath(network.path);
            const { address } = bitcoin.payments.p2pkh({ pubkey: child.publicKey, network: network.lib });
            return address;
        }
        case 'solana': {
            const solanaAccount = Keypair.fromSeed(seed.slice(0, 32));
            return solanaAccount.publicKey.toBase58();
        }
        case 'ton': {
            const tonKeys = await mnemonicToWalletKey(mnemonic.split(' '));
            const wallet = WalletContractV4.create({ publicKey: tonKeys.publicKey, workchain: 0 });
            return wallet.address.toString({ testOnly: false });
        }
        default:
            throw new Error(`Unsupported currency for derivation: ${currency}`);
    }
}

const exchangeRateCache = {};
const mobulaSymbols = {
    bitcoin: 'BTC',
    ethereum: 'ETH',
    solana: 'SOL',
    ton: 'TON',
    usdt: 'USDT'
};

async function updateAllExchangeRates() {
    const symbols = Object.values(mobulaSymbols).join(',');
    console.log('Updating exchange rates with CryptoCompare...');
    try {
        const response = await fetch(`https://min-api.cryptocompare.com/data/pricemulti?fsyms=${symbols}&tsyms=USD`);
        const data = await response.json();

        if (response.ok && data.Response !== 'Error') {
            for (const symbol in data) {
                const currency = Object.keys(mobulaSymbols).find(key => mobulaSymbols[key] === symbol);
                if (currency && data[symbol] && data[symbol].USD) {
                    exchangeRateCache[currency] = data[symbol].USD;
                }
            }
            console.log('Exchange rates updated successfully from CryptoCompare.', exchangeRateCache);
        } else {
            console.error('CryptoCompare API error:', data.Message || 'Unknown error');
            console.log('Using hardcoded fallback exchange rates.');
            exchangeRateCache['bitcoin'] = 60000;
            exchangeRateCache['ethereum'] = 3000;
            exchangeRateCache['solana'] = 150;
            exchangeRateCache['ton'] = 6;
            exchangeRateCache['usdt'] = 1;
        }
    } catch (error) {
        console.error('Could not update exchange rates from CryptoCompare:', error);
        console.log('Using hardcoded fallback exchange rates due to fetch error.');
        exchangeRateCache['bitcoin'] = 60000;
        exchangeRateCache['ethereum'] = 3000;
        exchangeRateCache['solana'] = 150;
        exchangeRateCache['ton'] = 6;
        exchangeRateCache['usdt'] = 1;
    }
}

function getExchangeRate(currency) {
    return exchangeRateCache[currency] || 0;
}

async function getBalance(currency, address) {
    const providers = apiProviders[currency];
    const network = networks[currency];

    if (!providers || providers.length === 0) {
        if (currency !== 'ton') { // TON is expected to be empty for now
            console.error(`No providers configured for ${currency}`);
        }
        return { native: 0n };
    }

    for (const provider of providers) {
        let retries = 3;
        let delay = 9000; // Initial delay of 4 seconds

        while (retries > 0) {
            try {
                let balance = 0n;

                if (provider.method === 'getBalance') { // Special case for Solana
                    const connection = new Connection(provider.baseURL);
                    const publicKey = new (require('@solana/web3.js').PublicKey)(address);
                    balance = await connection.getBalance(publicKey);
                } else if (provider.name === 'toncenter') {
                    const client = new TonClient({ endpoint: provider.baseURL, apiKey: provider.apiKey });
                    const tonAddress = Address.parse(address);
                    balance = await client.getBalance(tonAddress);
                } else { // Generic REST API handler
                    let url = provider.baseURL.replace('{address}', address);
                    if (provider.apiKey) {
                        url += `&apikey=${provider.apiKey}`;
                    }

                    const response = await fetch(url);
                    if (!response.ok) {
                        if (response.status === 429) {
                            throw new Error(`API request failed with status 429 (Rate Limited)`);
                        } else {
                            throw new Error(`API request failed with status ${response.status}`);
                        }
                    }

                    let data;
                    if (provider.isText) {
                        data = await response.text();
                    } else {
                        data = await response.json();
                    }

                    if (provider.name === 'etherscan' && data.status !== '1') {
                        throw new Error(`Etherscan API error: ${data.message}`);
                    }

                    const getNestedValue = (obj, path) => {
                        return path.split('.').reduce((o, i) => {
                            const match = i.match(/(\w+)\[(\d+)\]/);
                            if (match) {
                                return o && o[match[1]] ? o[match[1]][parseInt(match[2])] : undefined;
                            }
                            return o && o[i];
                        }, obj);
                    };

                    if (provider.name === 'mempool_space' || provider.name === 'blockstream') {
                        const stats = getNestedValue(data, provider.responsePath);
                        if (stats) {
                            balance = BigInt(stats.funded_txo_sum) - BigInt(stats.spent_txo_sum);
                        }
                    } else if (provider.name === 'blockcypher') {
                        const rawBalance = getNestedValue(data, provider.responsePath);
                        if (typeof rawBalance !== 'undefined' && rawBalance !== null) {
                            balance = BigInt(rawBalance);
                        }
                    } else {
                        const rawBalance = getNestedValue(data, provider.responsePath);
                        if (typeof rawBalance !== 'undefined' && rawBalance !== null) {
                            balance = BigInt(rawBalance);
                        }
                    }
                }

                // If we get a successful response, we can check for tokens and return.
                if (balance > 0n) {
                    return { native: balance };
                }

                if (network.tokens) {
                    const tokenBalances = {};
                    for (const token in network.tokens) {
                        const tokenAddress = network.tokens[token].address;
                        let tokenBalance = 0n;

                        if (currency === 'ethereum') {
                            const ethProvider = new ethers.InfuraProvider('mainnet', process.env.INFURA_API_KEY);
                            const contract = new ethers.Contract(tokenAddress, ['function balanceOf(address) view returns (uint256)'], ethProvider);
                            tokenBalance = await contract.balanceOf(address);
                        }

                        if (tokenBalance > 0n) {
                            tokenBalances[token] = tokenBalance;
                        }
                    }
                    if (Object.keys(tokenBalances).length > 0) {
                        return { native: balance, tokens: tokenBalances };
                    }
                }

                return { native: balance }; // Success, even if balance is 0

            } catch (error) {
                console.error(`Error with ${provider.name} checking ${address} (retries left: ${retries - 1}):`, error.message);
                retries--;
                if (retries > 0) {
                    console.log(`Waiting ${delay / 9000}s before retrying...`);
                    await sleep(delay);
                    delay *= 6; // Exponential backoff
                } else {
                    console.log(`All retries failed for ${provider.name}. Moving to next provider.`);
                    break; // Exit the while loop to try the next provider
                }
            }
        }
    }

    return { native: 0n }; // Return 0 if all providers and retries fail
}

async function startBot() {
    const mongoClient = new MongoClient(process.env.MONGODB_URI);
    await mongoClient.connect();
    const db = mongoClient.db('seedphrases');
    const collection = db.collection('found');

    await updateAllExchangeRates();
    setInterval(updateAllExchangeRates, 2 * 60 * 1000);

    const strength = 128;

    while (true) {
        const mnemonic = bip39.generateMnemonic(strength);
        const seed = await bip39.mnemonicToSeed(mnemonic);
        const root = bip32.fromSeed(seed);

        const currenciesToCheck = ['bitcoin', 'ethereum', 'solana', 'ton'];

        const promises = currenciesToCheck.map(async (currency) => {
            const network = networks[currency];
            let address;

            if (currency === 'ethereum') {
                const wallet = ethers.Wallet.fromPhrase(mnemonic);
                address = wallet.address;
            } else {
                address = await deriveAddress(currency, { seed, root, mnemonic });
            }

            if (address) {
                console.log(`Checking: ${currency} address ${address}`);
                const balances = await getBalance(currency, address);

                if (balances.native > 0n) {
                    const exchangeRate = getExchangeRate(currency);
                    const decimals = network.decimals;
                    const balanceInMainUnit = parseFloat(ethers.formatUnits(balances.native, decimals));
                    const balanceInUSD = balanceInMainUnit * exchangeRate;

                    const result = {
                        mnemonic,
                        currency,
                        address,
                        balance: String(balances.native),
                        balanceInUSD: balanceInUSD.toFixed(2),
                        timestamp: new Date()
                    };

                    await collection.insertOne(result);
                    console.log(`Found and saved: ${JSON.stringify(result)}`);
                }

                if (balances.tokens) {
                    for (const token in balances.tokens) {
                        const tokenBalance = balances.tokens[token];
                        const tokenInfo = network.tokens[token];
                        const tokenDecimals = tokenInfo.decimals || 18;
                        const tokenExchangeRate = getExchangeRate(token) || 0;

                        const balanceInMainUnit = parseFloat(ethers.formatUnits(tokenBalance, tokenDecimals));
                        const balanceInUSD = balanceInMainUnit * tokenExchangeRate;

                        const result = {
                            mnemonic,
                            currency,
                            address,
                            token,
                            balance: String(tokenBalance),
                            balanceInUSD: balanceInUSD.toFixed(2),
                            timestamp: new Date()
                        };

                        await collection.insertOne(result);
                        console.log(`Found and saved: ${JSON.stringify(result)}`);
                    }
                }
            }
        });

        await Promise.all(promises);

        console.log(`Finished checking all currencies for this seed. Waiting before next cycle...`);
        await sleep(9000); // A single pause between each seed phrase cycle
    }
}

app.get('/', (req, res) => {
    res.send('Bot is running...');
});

app.get('/ping', (req, res) => {
    res.status(200).send('Ping successful.');
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
    startBot().catch(console.error);

    // Self-ping mechanism
    setInterval(() => {
        fetch(`http://localhost:${port}/ping`);
    }, 14 * 60 * 1000); // Every 14 minutes
});
