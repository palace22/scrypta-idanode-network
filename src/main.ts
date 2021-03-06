import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
let ScryptaCore = require('@scrypta/core')
let scrypta = new ScryptaCore
let console = require('better-console')
import * as ScryptaRPC from './libs/ScryptaRPC'
const axios = require('axios')
var PouchDB = require('pouchdb')
var db = new PouchDB('rewards')
PouchDB.plugin(require('pouchdb-find'))
let Crypto = require('crypto')
const fs = require('fs')

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  app.enableCors();
  await app.listen(3000)

  db.createIndex({
    index: { fields: ['paid'] }
  })

  db.createIndex({
    index: { fields: ['node'] }
  })

  db.createIndex({
    index: { fields: ['block'] }
  })

  checkSystems()
  writeStatus()

  setInterval(function () {
    checkSystems()
  }, 60000)

  setInterval(function () {
    writeStatus()
  }, 180000)
}

async function checkSystems() {
  let RPC = new ScryptaRPC.Wallet
  let getinfo = await RPC.request('getinfo')
  let dbinfo

  try {
    dbinfo = await db.info()
  } catch (e) {
    console.error('DB IS NOT WORKING')
  }

  if (getinfo !== undefined && dbinfo !== undefined) {
    if (getinfo['result'].blocks > 0) {
      console.info('WALLET IS OK, STARTING IDANODE CHECK')
      let idanodes = await scrypta.returnNodes()
      let timestamp = new Date().getTime()

      for (let k in idanodes) {
        let node = idanodes[k]
        console.log('SYNC CHECK ON ' + node)
        let check = await scrypta.get('/wallet/getinfo', node).catch(err => {
          console.log('IDANODE DOESN\'T ANSWER')
        })
        if (check.blocks !== undefined && check.toindex <= 1) {
          console.info('IDANODE IS SYNCED [' + check.toindex + ' BLOCKS]')
          console.log('INTEGRITY CHECK ON ' + node)

          let checksumversion = await checkVersion(check.version)
          let integritycheck = await scrypta.get('/wallet/integritycheck', node)

          if (checksumversion === integritycheck.checksum) {
            console.info('IDANODE INTEGRITY CHECK PASSED')

            let _id = Crypto.createHash("sha256").update(timestamp + 'N' + node).digest("hex")
            let ref = Crypto.createHash("sha256").update(timestamp.toString()).digest("hex")

            db.put({
              _id: _id,
              node: node,
              block: check.blocks,
              toindex: check.toindex,
              paid: false,
              timestamp: timestamp,
              ref: ref
            })

          } else {
            console.error('IDANODE IS CORRUPTED')
          }
        }
      }

      checkPayouts()

    } else {
      console.error('WALLET ISN\'T SYNCING')
    }
  } else {
    console.error('WALLET IS NOT READY, PLEASE RUN IT FIRST.')
  }

}

function checkVersion(version) {
  return new Promise(async response => {
    try {
      let checksums_git = await axios.get('https://raw.githubusercontent.com/scryptachain/scrypta-idanodejs/master/checksum')
      let checksums = checksums_git.data.split("\n")
      for (let x in checksums) {
        let checksum = checksums[x].split(':')
        if (checksum[0] === version) {
          response(checksum[1])
        }
      }
      response(false)
    } catch (e) {
      console.log(e)
      response(false)
    }
  })
}

async function checkPayouts() {
  let dbinfo

  try {
    dbinfo = await db.info()
  } catch (e) {
    console.error('DB IS NOT WORKING')
  }
  if (dbinfo !== undefined) {
    let idanodes = await scrypta.returnNodes()
    console.info('CHECKING PAYOUTS')
    let unpaid = await db.find({
      selector: {
        paid: false
      }
    })
    unpaid.docs.sort(function (a, b) { return a.block - b.block })
    let toPay = unpaid.docs
    let payoutByNodes = {}
    for (let x in toPay) {
      let payout = toPay[x]
      if (payoutByNodes[payout.node] === undefined) {
        payoutByNodes[payout.node] = []
      }
      if (payout.paid === false) {
        payoutByNodes[payout.node].push(payout)
      }
    }
    let RPC = new ScryptaRPC.Wallet
    let getinfo = await RPC.request('getinfo')
    let balance = getinfo['result']['balance']
    let stake = idanodes.length * 5000
    balance = balance - stake

    console.log('POOL BALANCE IS ' + balance + ' lyra')
    let totpayouts = 0
    let maxpayouts = 1440

    if (balance !== undefined && balance > 0) {
      for (let k in payoutByNodes) {
        console.info(k + ' HAVE ' + payoutByNodes[k].length + ' UNPAID PAYOUTS')
        totpayouts += payoutByNodes[k].length
      }
      for (let k in payoutByNodes) {
        var share = (balance * payoutByNodes[k].length / totpayouts).toFixed(8)
        console.info(k + ' HAVE ' + share + ' LYRA TO EARN')
      }

      let midpayouts = totpayouts / idanodes.length
      console.log('MID PAYOUTS ARE ' + midpayouts)

      if (midpayouts >= maxpayouts) {
        console.log('24H PASSED, DISTRIBUTING SHARES.')
        let nodes_git = await axios.get('https://raw.githubusercontent.com/scryptachain/scrypta-idanode-network/master/peersv2')
        let raw_nodes = nodes_git.data.split("\n")
        let unlockwallet = await RPC.request('walletpassphrase', [process.env.WALLET_PASSWORD, 999999])
        const defaultIdanodeName = 'idanodejs'
        
        if (unlockwallet['error'] === null) {
          for (let x in raw_nodes) {
            let node = raw_nodes[x].split(':')
            let idanodeName = node[3] ? node[3] : defaultIdanodeName
            let url = 'https://' + idanodeName + node[0] + '.scryptachain.org'
            let address = await scrypta.getAddressFromPubKey(node[2])
            console.info('SENDING PAYOUT TO ' + url + ' -> ADDRESS IS ' + address)
            let validateaddress = await RPC.request('validateaddress', [address])
            if (validateaddress['result']['isvalid'] !== undefined && validateaddress['result']['isvalid'] === true) {
              let sharelessfees = parseFloat(share) - 0.003
              await RPC.request('settxfee', [0.003])
              let txid = await RPC.request('sendtoaddress', [address, sharelessfees])
              if (txid['result'] !== undefined && txid['error'] === null) {
                let payouts = payoutByNodes[url]
                for (let xx in payouts) {
                  payouts[xx].paid = true
                  try {
                    await db.put(payouts[xx])
                    console.log('SEND SUCCESS TXID IS: ' + txid['result'])
                  } catch (e) {
                    console.log(e)
                  }
                }
              }
            }
          }
          await RPC.request('walletpassphrase', [process.env.WALLET_PASSWORD, 999999999, true])
        } else {
          console.error('WALLET PASSPHRASE IS WRONG')
        }
      } else {
        console.log('LESS THAN 24H PASSED.')
      }
    } else {
      console.log('NOT ENOUGH BALANCE.')
    }
  }
}

async function writeStatus() {
  let dbinfo

      try {
        dbinfo = await db.info()
      } catch (e) {
        console.log('DB IS NOT WORKING')
      }

      if (dbinfo !== undefined) {
        let RPC = new ScryptaRPC.Wallet
        let getinfo = await RPC.request('getinfo')
        let idanodes = await scrypta.returnNodes()
        let unpaid = await db.find({
          selector: {
            paid: false
          }
        })
        unpaid.docs.sort(function (a, b) { return a.block - b.block })
        let toPay = unpaid.docs
        let payoutByNodes = {}
        let payoutByNodesCount = {}

        for (let x in toPay) {
          let payout = toPay[x]
          if (payoutByNodes[payout.node] === undefined) {
            payoutByNodes[payout.node] = []
          }
          if (payout.paid === false) {
            payoutByNodes[payout.node].push(payout)
          }
        }
        let balance = getinfo['result']['balance']
        let stake = idanodes.length * 5000
        balance = balance - stake

        if (balance < 0) {
          balance = 0
        }
        let totpayouts = 0

        for (let k in payoutByNodes) {
          payoutByNodesCount[k] = payoutByNodes[k].length
          totpayouts += payoutByNodes[k].length
        }
        let shares = {}
        let earnings = {}
        for (let k in payoutByNodes) {
          var share = (balance * payoutByNodes[k].length / totpayouts).toFixed(8)
          earnings[k] = share
          if (balance > 0) {
            let percentage = (100 / balance * parseFloat(share)).toFixed(2)
            shares[k] = parseFloat(percentage)
            earnings[k] = parseFloat(share) - 0.003
          } else {
            shares[k] = 0
          }
        }

        let midpayouts = totpayouts / idanodes.length

        let status = {
          uptime: payoutByNodesCount,
          timing: parseFloat(midpayouts.toFixed(0)),
          earnings: earnings,
          shares: shares,
          stake: balance
        }

        fs.writeFileSync('./status', JSON.stringify(status))
        
      }
}

bootstrap()
