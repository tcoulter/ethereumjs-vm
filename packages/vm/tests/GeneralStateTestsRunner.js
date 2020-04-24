const async = require('async')
const testUtil = require('./util')
const Trie = require('merkle-patricia-tree/secure')
const ethUtil = require('ethereumjs-util')
const Account = require('ethereumjs-account').default
const BN = ethUtil.BN

function parseTestCases(forkConfigTestSuite, testData, data, gasLimit, value) {
  let testCases = []
  if (testData['post'][forkConfigTestSuite]) {
    testCases = testData['post'][forkConfigTestSuite].map((testCase) => {
      let testIndexes = testCase['indexes']
      let tx = { ...testData.transaction }
      if (data !== undefined && testIndexes['data'] !== data) {
        return null
      }

      if (value !== undefined && testIndexes['value'] !== value) {
        return null
      }

      if (gasLimit !== undefined && testIndexes['gas'] !== gasLimit) {
        return null
      }

      tx.data = testData.transaction.data[testIndexes['data']]
      tx.gasLimit = testData.transaction.gasLimit[testIndexes['gas']]
      tx.value = testData.transaction.value[testIndexes['value']]
      return {
        transaction: tx,
        postStateRoot: testCase['hash'],
        env: testData['env'],
        pre: testData['pre'],
      }
    })
  }

  testCases = testCases.filter((testCase) => {
    return testCase != null
  })

  return testCases
}

function runTestCase(options, testData, t, cb) {
  const state = new Trie()
  let block, vm

  async.series(
    [
      function (done) {
        let VM
        if (options.dist) {
          VM = require('../dist/index.js').default
        } else {
          VM = require('../lib/index').default
        }
        vm = new VM({
          state,
          hardfork: options.forkConfigVM,
        })
        testUtil.setupPreConditions(state, testData, done)
      },
      function (done) {
        let tx = testUtil.makeTx(testData.transaction, options.forkConfigVM)
        block = testUtil.makeBlockFromEnv(testData.env)
        tx._homestead = true
        tx.enableHomestead = true
        block.isHomestead = function () {
          return true
        }

        if (!tx.validate()) {
          return done()
        }

        if (options.jsontrace) {
          vm.on('step', function (e) {
            let hexStack = []
            hexStack = e.stack.map((item) => {
              return '0x' + new BN(item).toString(16, 0)
            })

            const opTrace = {
              pc: e.pc,
              op: e.opcode.opcode,
              gas: '0x' + e.gasLeft.toString('hex'),
              gasCost: '0x' + e.opcode.fee.toString(16),
              stack: hexStack,
              depth: e.depth,
              opName: e.opcode.name,
            }

            t.comment(JSON.stringify(opTrace))
          })
          vm.on('afterTx', () => {
            let stateRoot = {
              stateRoot: vm.stateManager._trie.root.toString('hex'),
            }
            t.comment(JSON.stringify(stateRoot))
          })
        }

        vm.runTx({ tx, block })
          .then(() => done())
          .catch(async (err) => {
            // If tx is invalid and coinbase is empty, the test harness
            // expects the coinbase account to be deleted from state.
            // Without this ecmul_0-3_5616_28000_96 would fail.
            const account = await vm.stateManager.getAccount(block.header.coinbase)
            if (new BN(account.balance).isZero()) {
              await vm.stateManager.putAccount(block.header.coinbase, new Account())
              await vm.stateManager.cleanupTouchedAccounts()
              await vm.stateManager._cache.flush()
            }
            done()
          })
      },
      async function (done) {
        if (testData.postStateRoot.substr(0, 2) === '0x') {
          testData.postStateRoot = testData.postStateRoot.substr(2)
        }
        t.equal(
          vm.stateManager._trie.root.toString('hex'),
          testData.postStateRoot,
          'the state roots should match',
        )

        if (stateRoot.toString('hex') !== testData.postStateRoot.toString('hex')) {
          // since General State Tests, postState keys are no longer included in
          // the state test format. only postStateRoot, so can't debug expected post conditions
          // testUtil.verifyPostConditions(state, testData.post, t, done)
          done()
        } else {
          done()
        }
      },
    ],
    cb,
  )
}

module.exports = function runStateTest(options, testData, t, cb) {
  try {
    const testCases = parseTestCases(
      options.forkConfigTestSuite,
      testData,
      options.data,
      options.gasLimit,
      options.value,
    )
    if (testCases.length > 0) {
      async.eachSeries(testCases, (testCase, done) => runTestCase(options, testCase, t, done), cb)
    } else {
      t.comment(`No ${options.forkConfigTestSuite} post state defined, skip test`)
      cb()
    }
  } catch (e) {
    t.fail('error running test case for fork: ' + options.forkConfigTestSuite)
    console.log('error:', e)
    cb()
  }
}
