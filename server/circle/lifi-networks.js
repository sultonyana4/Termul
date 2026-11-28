import { createPublicClient, http, keccak256, parseAbi } from 'viem';
import { arcRpc } from '../../experiments/circle-wallet-poc/arc.js';

const router = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE';
const forwarder = '0xDe2b920506EE931a6A2ABDF566526220214FBbAE';
const modernSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const legacySlot = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';
const defaultPoolHash = '0x932cddc50793da935ccf915651ad67f6b746e9936fcc5614f0ff492563782c75';
const polygonStyleRouterHash = '0x828f8a0694bfba25c80a406283f149d701cdc944acbbc18b57315cf157db9220';
const acrossFacet = '0xAd3f1634a917924cBb54A0F76e43ca035D2B6BCd';
// Pins are for the exact bytecode and proxy implementations inspected through read-only RPC.
export const lifiNetworks = Object.freeze({
  5042: {
    code: 'ARC', gas: 'USDC', domain: 26, router: '0xA4072583658Fae592A3506A42431cb6316a8d40b',
    routerHash: '0xca0fd158089c97d9e77828a4254bc7037be8ee6f784e45d80204df0e56013101',
    forwarder: '0x906A51f3d8dF12B7030D5299D1098dd89fFe830b',
    token: ['0x3600000000000000000000000000000000000000','0xc9987bd3af6b26a030951faa7eacc017b68343aeedf3ce5fe68f821c4b93939d'],
    across: ['0xbfe96f30dCa6Dd1705A53E6a8DA32E9090f2eB75','0xf637151095381e55b083cfb0e076403f2b86296f43d362a2f5ba79712d5ca06d'],
    pool: ['0x9b4A302A548c7e313c2b74C461db7b84d3074A84','0xbad165a67f16d7be75d8197acdecb912517a516ce0ca2249dee18cd643577f61','0xe34efdf3111aa617583a8ab4a93c351d44fad5175d449c1dda4aad62ea3ae91d'],
    transmitterImpl: '0x3b5d3d6b6036d5b0c88d727440fa7391d5ab0fb2c32ae68bea880589c5dbf578',
    messengerImpl: '0x09a9af29d53ac3e54c73284527cf86215cd377486855a33ac3de899a2a77c314',
  },
  8453: {
    code: 'BASE', gas: 'ETH', domain: 6, router, routerHash: '0x5efa2ebe1ed041ce83c069f1cedc04945f1438680dacf5f88068ef6c7d94110a',
    forwarder,
    token: ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913','0xa6705a10bb756b5dea144591118be77d7af0c3eee3bf2dfe2583dcb0364fefab','0x11b75a237997ab8328f65b2d5a55c10f0346d0a175741ed42ddf4f2c66b9e873'],
    across: [acrossFacet,'0x0d049cb64bfcb713b3fe8fa4727ae763cc1efe1e741ea5c43d41d07add0fb1f8'],
    polymerStandard: ['0x5e79e8c67cc7fed03b283e84a5e16500f094b6b5','0x9edfe421526ca1388d1a99a35f375c3f617fae8d77873e67b559e9ba869b0b3f'],
    pool: ['0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64',defaultPoolHash,'0xb36f3bbdffcc931890a4354aa13c9756f032cf6f968d1d1a9604cb3ece9eb480'],
    transmitterImpl: '0x1c103738027742a17d3758356fc53deff294f9ac593189e104542e781c6f04a5',
    messengerImpl: '0x6c864e374854e06fd5d42b3e9de53ef9ad4d863b83a8c5dd1cf6e2a67fd2b535',
  },
  42161: {
    code: 'ARB', gas: 'ETH', router, routerHash: polygonStyleRouterHash, forwarder,
    token: ['0xaf88d065e77c8cC2239327C5EDb3A432268e5831','0xad30d819dbc47814b7e6cb837fd7cc57fcb591479a38596ee93de4fc52e8c435','0xda0578bf7fe0d04e320e166ab8f98061328fda8ae0a299882aeb38f1543c6a9d'],
    across: [acrossFacet,'0xf55f58c8e685178b358b945bcc6c6c7ba0d96cc78f6f22878a4a862f2ba8d339'],
    pool: ['0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A',defaultPoolHash,'0xa860f20748abfdf98f4e55411b5db7630457bec1abfb5d88f1ecd5f25b4ec24b'],
  },
  10: {
    code: 'OP', gas: 'ETH', router, routerHash: polygonStyleRouterHash, forwarder,
    token: ['0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85','0xaad43333d28e146557f1c682e8a4226743fb231fdd00a577512233bd9e920008','0x24c6e8b8e0aaea31861e014c15e9da1564402d3512eb474d46def8e8bb2b2259'],
    across: [acrossFacet,'0x5a04fc18f35fa01344a2d752123551bc57edb3065573fe0ef02d5d8108591298'],
    pool: ['0x6f26Bf09B1C792e3228e5467807a900A503c0281',defaultPoolHash,'0xcf5c48ec3d2a4cbd9e097f08e8888e4c07d8698e626414e284f52b66515e2b21'],
  },
});

export const lifiClients = {
  5042: arcRpc,
  ...Object.fromEntries(Object.entries({
    8453: 'https://mainnet.base.org', 42161: 'https://arb1.arbitrum.io/rpc', 10: 'https://mainnet.optimism.io',
  }).map(([id, url]) => [id, createPublicClient({ transport: http(url, { timeout: 5000, retryCount: 0, methods: {
    include: ['eth_chainId','eth_getCode','eth_getStorageAt','eth_call','eth_estimateGas','eth_gasPrice','eth_getBalance',
      'eth_blockNumber','eth_getBlockByNumber','eth_getLogs','eth_getTransactionReceipt','eth_getTransactionByHash'],
  } }) })])),
};

const proxyHash = '0xd2c8d48075d832fb7d07f6db5545a1bee37fdf886325c441a8dd1cef4c9dae99';
export const polymerTransmitter = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64';
const polymerMessenger = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d';
const forwarderHash = '0x99a76627aece8903612e0246c10f13a46e511a0a074d9a4e68987a28c78ebd52';
const getters = parseAbi([
  'function facetAddress(bytes4) view returns (address)', 'function SPOKEPOOL() view returns(address)',
  'function getChainIdToDomainId(uint256) view returns(uint32)',
]);

export async function verifyLifiDeployment(client, plan, { destination = false, blockNumber } = {}) {
  const id = destination ? plan.toChain : plan.fromChain;
  const network = lifiNetworks[id];
  if (!network || await client.getChainId() !== id) throw new Error('The LI.FI RPC chain changed.');
  const at = blockNumber === undefined ? {} : { blockNumber };
  async function verify([address, expected, implementation], slot = modernSlot) {
    const code = await client.getCode({ address, ...at });
    if (!code || keccak256(code) !== expected) throw new Error('A LI.FI deployment changed.');
    if (implementation) {
      const word = await client.getStorageAt({ address, slot, ...at });
      if (!/^0x0{24}[a-f0-9]{40}$/i.test(word ?? '')) throw new Error('A LI.FI proxy changed.');
      const bytecode = await client.getCode({ address: '0x' + word.slice(-40), ...at });
      if (!bytecode || keccak256(bytecode) !== implementation) throw new Error('A LI.FI implementation changed.');
    }
  }

  const protocol = plan.tool === 'across'
    ? [verify(network.pool)]
    : [verify([polymerTransmitter, proxyHash, network.transmitterImpl]), verify([polymerMessenger, proxyHash, network.messengerImpl])];
  await Promise.all([verify(network.token, legacySlot), ...protocol]);
  if (destination) return;
  const facet = network[plan.tool];
  const routed = await client.readContract({ address: network.router, abi: getters, functionName: 'facetAddress', args: [plan.data.slice(0, 10)], ...at });
  if (!facet || routed.toLowerCase() !== facet[0].toLowerCase()) throw new Error('The LI.FI facet changed.');
  await Promise.all([verify([network.router, network.routerHash]), verify(facet), verify([network.forwarder, forwarderHash])]);
  if (plan.tool === 'across') {
    const pool = await client.readContract({ address: facet[0], abi: getters, functionName: 'SPOKEPOOL', ...at });
    if (pool.toLowerCase() !== network.pool[0].toLowerCase()) throw new Error('The Across pool changed.');
  } else {
    const domain = await client.readContract({ address: network.router, abi: getters, functionName: 'getChainIdToDomainId', args: [BigInt(plan.toChain)], ...at });
    if (domain !== lifiNetworks[plan.toChain].domain) throw new Error('The Polymer domain changed.');
  }
}
