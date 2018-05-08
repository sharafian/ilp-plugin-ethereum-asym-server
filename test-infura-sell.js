const PluginEthereumAsymServer = require('.')
const IlDcp = require('ilp-protocol-ildcp')
const IlpPacket = require('ilp-packet')
const HDWalletProvider = require('truffle-hdwallet-provider')
const Store = require('ilp-store-memory')
const crypto = require('crypto')

function sha256(preimage) {
    return crypto.createHash('sha256').update(preimage).digest()
}


if (typeof process.env.PROVIDER_URL == 'undefined' || typeof process.env.SECRET == 'undefined') {
    console.error('Please set the PROVIDER_URL and SECRET env vars!')
    process.exit(1)
}

console.log('creating provider')

const provider = new HDWalletProvider(process.env.SECRET, process.env.PROVIDER_URL)
const account = '0x' + provider.address.substring(2).toLowerCase()
console.log('Connecting to local port 6666, settling over Machinomy Ethereum, account:', account)

const plugin = new PluginEthereumAsymServer({
    account: account,
    db: 'nedb://./server',
    port: 6666,
    _store: new Store(),
    provider: provider,
    minimumChannelAmount: '10000'
})

plugin.registerDataHandler(packet => {
    const prepare = IlpPacket.deserializeIlpPrepare(packet)
    console.log('got data', prepare)
    return IlpPacket.serializeIlpFulfill({ fulfillment: crypto.randomBytes(32), data: Buffer.from([]) })
})

plugin.registerMoneyHandler(packet => {
    console.log('got money!', packet)
})

plugin.connect().then(async () => {

})