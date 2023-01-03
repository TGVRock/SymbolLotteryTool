
// symbol-sdk と関連モジュールのインポート
const sym = require("symbol-sdk");
const { async } = require('rxjs');

const MAINNODE = "https://ik1-432-48199.vs.sakura.ne.jp:3001";  // MAINNET
const TESTNODE = "https://vmi835904.contaboserver.net:3001";    // TESTNET

// ネットワークタイプ
const NetTypeEnum = {
  Main : 104,
  Test : 152,
};

// 抽選状態
const LotteryStateEnum = {
  Duplicate : -1,
  Vote : 0,
  // 1以降は当選状態
};

// リポジトリ
let repo = null;
let txRepo = null;
let nsRepo = null;
let wsEndpoint = null;

let networkType = null;
let generationHash = null;
let epochAdjustment = null;

let listener = null;
let txList = [];

// リスナースタート
startListen = (async function(address, netType) {
  // リポジトリ設定
  if (!(await setRepository(netType))) {
    return false;
  }

  txList = [];
  listener = new sym.Listener(wsEndpoint,nsRepo,WebSocket);
  listener.open().then(() => {
    listener.newBlock();

    // 承認トランザクションの検知
    const rawAddress = sym.Address.createFromRawAddress(address);
    listener.confirmed(rawAddress)
    .subscribe(async tx  => {
      // トランザクション情報の取得
      const txInfo = await txRepo.getTransaction(
        tx.transactionInfo.hash,
        sym.TransactionGroup.Confirmed
      ).toPromise();

      // 転送トランザクション以外は対象外
      switch (txInfo.type) {
        case sym.TransactionType.TRANSFER:
          // 転送トランザクションは抽選対象
          addTxList(txInfo);
          break;
      
        case sym.TransactionType.AGGREGATE_BONDED:
        case sym.TransactionType.AGGREGATE_COMPLETE:
          // アグリゲートトランザクションの場合、対象アドレスへの転送トランザクションが含まれていれば抽選対象
          for (let idxInnerTx = 0; idxInnerTx < txInfo.innerTransactions.length; idxInnerTx++) {
            const innerTx = txInfo.innerTransactions[idxInnerTx];
            if (sym.TransactionType.TRANSFER === innerTx.type && rawAddress.plain() === innerTx.recipientAddress.plain()) {
              addTxList(innerTx);
              break;
            }
          }
          break;
      
        default:
          // 転送トランザクション以外は対象外
          break;
      }
    });

    listener.webSocket.onclose = async function(){
        console.log('listener closed.');
    }
  });
  console.log('Listen Start.');

  return true;
});

// リスナーストップ
stopListen = (async function() {
  if (null !== listener) {
    listener.close();
  }
  console.log('Listen Stop.');
  return true;
});

// アドレスリストの取得
getAddressList = (async function() {
  return txList;
});

// 抽選実行
lotteryTransaction = (function() {
  const voteIdxList = [];
  for (let idx = 0; idx < txList.length; idx++) {
    if (LotteryStateEnum.Vote === txList[idx].state) {
      voteIdxList.push(idx);
    }
  }
  if (0 === voteIdxList.length) {
    return false;
  }
  const selectedIdx = voteIdxList[Math.floor(Math.random() * voteIdxList.length)];
  const selectedTxList = txList.filter(addr => ((addr.state !== LotteryStateEnum.Duplicate) && (addr.state !== LotteryStateEnum.Vote)));
  txList[selectedIdx].state = selectedTxList.length + 1;
  return true;
});

// リポジトリ設定
async function setRepository(netType) {
  // 既にリポジトリが設定済みの場合は設定不要
  if (null !== repo) {
    return true;
  }

  // ノードURIの取得
  let nodeUri = '';
  switch (Number(netType)) {
    // メインネット
    case NetTypeEnum.Main:
      nodeUri = MAINNODE;
      break;
  
    // テストネット
    case NetTypeEnum.Test:
      nodeUri = TESTNODE;
      break;
  
    default:
      return false;
  }

  // リポジトリ設定
  repo = new sym.RepositoryFactoryHttp(nodeUri);
  txRepo = repo.createTransactionRepository();
  nsRepo = repo.createNamespaceRepository();
  wsEndpoint = nodeUri.replace('http', 'ws') + "/ws";

  networkType = await repo.getNetworkType().toPromise();
  generationHash = await repo.getGenerationHash().toPromise();
  epochAdjustment = await repo.getEpochAdjustment().toPromise();

  return true;
}

// リポジトリ設定
async function addTxList(txInfo) {
  // タイムスタンプの算出
  const timstamp = (epochAdjustment * 1000) + Number(txInfo.transactionInfo.timestamp.toString());
  const dateTime = new Date(timstamp);

  // 同じアドレスの2回目以降のトランザクションは対象外にする
  const isDuplicate = txList.find(addr => (addr.address === txInfo.signer.address.plain()));

  // リスト追加
  txList.push({
    time: dateTime.toLocaleDateString('ja-JP') + ' ' + dateTime.toLocaleTimeString('ja-JP'),
    address: txInfo.signer.address.plain(),
    state: isDuplicate ? LotteryStateEnum.Duplicate : LotteryStateEnum.Vote,
    message: sym.MessageType.EncryptedMessage === txInfo.message.type ? '[Encrypted Message]' : txInfo.message.payload,
  });
}