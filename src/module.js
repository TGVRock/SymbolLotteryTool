
// symbol-sdk と関連モジュールのインポート
const sym = require("symbol-sdk");
const { async } = require('rxjs');
const { UInt64 } = require("symbol-sdk");

const MAINNODE = "https://ik1-432-48199.vs.sakura.ne.jp:3001";  // MAINNET
const TESTNODE = "https://vmi831828.contaboserver.net:3001";    // TESTNET

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
let blockRepo = null;
let nsRepo = null;
let wsEndpoint = null;

let epochAdjustment = null;

let listener = null;
let addressList = [];

let startDateBlock = undefined;
let endDateBlock = undefined;

// リスナースタート
startListen = (async function(address, netType) {
  // リポジトリ設定
  if (!(await setRepository(netType))) {
    return false;
  }

  addressList = [];
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
          addAddressList(txInfo);
          break;
      
        case sym.TransactionType.AGGREGATE_BONDED:
        case sym.TransactionType.AGGREGATE_COMPLETE:
          // アグリゲートトランザクションの場合、対象アドレスへの転送トランザクションが含まれていれば抽選対象
          for (let idxInnerTx = 0; idxInnerTx < txInfo.innerTransactions.length; idxInnerTx++) {
            const innerTx = txInfo.innerTransactions[idxInnerTx];
            if (sym.TransactionType.TRANSFER === innerTx.type && rawAddress.plain() === innerTx.recipientAddress.plain()) {
              addAddressList(innerTx);
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
stopListen = (function() {
  if (null !== listener) {
    listener.close();
  }
  console.log('Listen Stop.');
  return true;
});

// アドレスリストの取得
getAddressList = (function() {
  return addressList;
});

// 抽選対象のアドレス個数の取得
getValidAddressNum = (function() {
  const validAddressList = addressList.filter(addr => (addr.state === LotteryStateEnum.Vote));
  return validAddressList.length;
});

// 抽選実行
lotteryTransaction = (function() {
  const voteIdxList = [];
  for (let idx = 0; idx < addressList.length; idx++) {
    if (LotteryStateEnum.Vote === addressList[idx].state) {
      voteIdxList.push(idx);
    }
  }
  if (0 === voteIdxList.length) {
    return false;
  }
  const selectedIdx = voteIdxList[Math.floor(Math.random() * voteIdxList.length)];
  const selectedAddressList = addressList.filter(addr => ((addr.state !== LotteryStateEnum.Duplicate) && (addr.state !== LotteryStateEnum.Vote)));
  addressList[selectedIdx].state = selectedAddressList.length + 1;
  return true;
});

// 特定期間のTx取得
getPeriodTxList = (async function(address, netType, startDateStr, endDateStr, allFlag) {
  // リポジトリ設定
  if (!(await setRepository(netType))) {
    return false;
  }

  const startDate = new Date(startDateStr + " 00:00:00");
  const endDate = new Date(endDateStr + " 23:59:59");
  startDateBlock = await getBlockHeightFromDate(netType, startDate);
  endDateBlock = await getBlockHeightFromDate(netType, endDate);

  const criteria = {
    type: [sym.TransactionType.TRANSFER, sym.TransactionType.AGGREGATE_BONDED, sym.TransactionType.AGGREGATE_COMPLETE],
    address: sym.Address.createFromRawAddress(address),
    group: sym.TransactionGroup.Confirmed,
    pageSize: 100,
    pageNumber: 1,
  };
  if (typeof startDateBlock != "undefined") {
    criteria.fromHeight = startDateBlock;
  }
  if (typeof endDateBlock != "undefined") {
    criteria.toHeight = endDateBlock;
  }
  const searchTxList = await searchTransactions(netType, criteria);
  console.log(searchTxList);

  // トランザクションリストの作成
  const txList = [];
  for (let index = 0; index < searchTxList.length; index++) {
    const tx = searchTxList[index];
    // 転送トランザクションの場合はそのまま追加
    if (tx.type === sym.TransactionType.TRANSFER) {
      if (address === tx.recipientAddress.plain()) {
        txList.push(tx);
      }
      continue;
    }
    // アグリゲートトランザクションの場合、対象アドレスへの転送トランザクションが含まれていれば抽選対象
    if (typeof tx.transactionInfo === "undefined" || typeof tx.transactionInfo.hash === "undefined" ) {
      continue;
    }
    const aggTxInfo = await txRepo.getTransaction(tx.transactionInfo.hash, sym.TransactionGroup.Confirmed).toPromise();
    if (typeof aggTxInfo === "undefined") {
      continue;
    }
    for (let idxInnerTx = 0; idxInnerTx < aggTxInfo.innerTransactions.length; idxInnerTx++) {
      const innerTx = aggTxInfo.innerTransactions[idxInnerTx];
      if (sym.TransactionType.TRANSFER === innerTx.type && address === innerTx.recipientAddress.plain()) {
        txList.push(innerTx);
        break;
      }
    }
    
  }
  // console.log(txList);

  txList.forEach(element => {
    addAddressListForTwitterAccount(element);
  });
  console.log(addressList);
  if (allFlag) {
    txList.forEach(element => {
      tempAddAddressListForTwitterAccount(element);
    });
    console.log("all", addressList);
  }

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
  blockRepo = repo.createBlockRepository();
  nsRepo = repo.createNamespaceRepository();
  wsEndpoint = nodeUri.replace('http', 'ws') + "/ws";
  epochAdjustment = await repo.getEpochAdjustment().toPromise();

  return true;
}

// アドレスリストへの追加
function addAddressList(txInfo) {
  // タイムスタンプの算出
  const timstamp = (epochAdjustment * 1000) + Number(txInfo.transactionInfo.timestamp.toString());
  const dateTime = new Date(timstamp);

  // 同じアドレスの2回目以降のトランザクションは対象外にする
  const isDuplicate = addressList.find(addr => (addr.address === txInfo.signer.address.plain()));

  // リスト追加
  addressList.push({
    time: dateTime.toLocaleDateString('ja-JP') + ' ' + dateTime.toLocaleTimeString('ja-JP'),
    address: txInfo.signer.address.plain(),
    state: isDuplicate ? LotteryStateEnum.Duplicate : LotteryStateEnum.Vote,
    message: sym.MessageType.EncryptedMessage === txInfo.message.type ? '[Encrypted Message]' : txInfo.message.payload,
  });
}

// アドレスリストへの追加
function addAddressListForTwitterAccount(txInfo) {
  // タイムスタンプの算出
  const timstamp = (epochAdjustment * 1000) + Number(txInfo.transactionInfo.timestamp.toString());
  const dateTime = new Date(timstamp);

  // 送信XYMの取得(実施記録用)
  const xymMosaic = txInfo.networkType === NetTypeEnum.Main ? new sym.MosaicId("6BED913FA20223F8") : new sym.MosaicId("72C0212E67A08BCE");
  const sendXymMosaic = txInfo.mosaics.find(mosaic => (mosaic.id.id.toHex() === xymMosaic.id.toHex()));
  const sendXym = typeof sendXymMosaic === "undefined" ? "N/A" : (Number(sendXymMosaic.amount.toString()) / (Math.pow(10, 6))).toString();

  console.log({
    address: txInfo.signer.address.plain(),
    date: dateTime.toLocaleDateString('ja-JP') + ' ' + dateTime.toLocaleTimeString('ja-JP'),
    xym: sendXym,
    messageType: txInfo.message.type,
    message: txInfo.message.payload,
  });

  // 同じアドレスの2回目以降のトランザクションは対象外にする
  const isDuplicate = addressList.find(addr => (addr.address === txInfo.signer.address.plain()));
  if (isDuplicate) {
    return;
  }

  // メッセージにTwitterアカウント名が含まれているか確認
  if (sym.MessageType.EncryptedMessage === txInfo.message.type) {
    return;
  }
  const message = txInfo.message.payload;
  let startIdx = message.indexOf('@');
  if (0 > startIdx) {
    // 全角も許容しておく
    startIdx = message.indexOf('＠');
    if (0 > startIdx) {
      return;
    }
  }
  let endIdx = message.indexOf(' ', startIdx);
  if (0 > endIdx) {
    // 全角も許容しておく
    endIdx = message.indexOf('　', startIdx);
  }
  const endLfIdx = message.indexOf("\n", startIdx);
  if (0 <= endLfIdx) {
    if (0 > endIdx) {
      endIdx = endLfIdx;
    } else if (endLfIdx < endIdx) {
      endIdx = endLfIdx;
    }
  }
  const accountName = 0 > endIdx ? message.substring(startIdx + 1) : message.substring(startIdx + 1, endIdx);
  // 既に同じアカウントが存在する場合は対象外にする
  const isSame = addressList.find(addr => (addr.twitter === accountName));

  // リスト追加
  addressList.push({
    time: dateTime.toLocaleDateString('ja-JP') + ' ' + dateTime.toLocaleTimeString('ja-JP'),
    address: txInfo.signer.address.plain(),
    twitter: accountName,
    state: isSame ? LotteryStateEnum.Duplicate : LotteryStateEnum.Vote,
    message: sym.MessageType.EncryptedMessage === txInfo.message.type ? '[Encrypted Message]' : txInfo.message.payload,
  });
}

// アドレスリストへの追加
function tempAddAddressListForTwitterAccount(txInfo) {
  // 既に同じアドレスが存在する場合は追加
  if (addressList.find(addr => (addr.address === txInfo.signer.address.plain()))) {
    return;
  }

  // タイムスタンプの算出
  const timstamp = (epochAdjustment * 1000) + Number(txInfo.transactionInfo.timestamp.toString());
  const dateTime = new Date(timstamp);

  console.log({
    address: txInfo.signer.address.plain(),
    date: dateTime.toLocaleDateString('ja-JP') + ' ' + dateTime.toLocaleTimeString('ja-JP'),
    messageType: txInfo.message.type,
    message: txInfo.message.payload,
  });

  // リスト追加
  addressList.push({
    time: dateTime.toLocaleDateString('ja-JP') + ' ' + dateTime.toLocaleTimeString('ja-JP'),
    address: txInfo.signer.address.plain(),
    twitter: "N/A",
    state: LotteryStateEnum.Vote,
    message: sym.MessageType.EncryptedMessage === txInfo.message.type ? '[Encrypted Message]' : txInfo.message.payload,
  });
}

// 日付に対応したブロック高の取得
async function getBlockHeightFromDate(netType, targetDate) {
  // リポジトリ設定
  if (!(await setRepository(netType))) {
    return false;
  }

  // 未来の時刻の場合はundefined
  if (typeof targetDate === "undefined" || targetDate == "Invalid Date") {
    return undefined;
  }
  if (Date.now() < targetDate) {
    return undefined;
  }

  // タイムスタンプの算出
  const realTimstamp = targetDate.getTime();
  const blockTimestamp = realTimstamp - (epochAdjustment * 1000);
  let predictHeight = Math.ceil(blockTimestamp / (45 * 1000));
  const predictBlockInfo = await blockRepo.getBlockByHeight(UInt64.fromUint(predictHeight)).toPromise();
  if (predictBlockInfo.timestamp <= blockTimestamp) {
    while (true) {
      const blockInfo = await blockRepo.getBlockByHeight(UInt64.fromUint(predictHeight + 99)).toPromise();
      const timestamp = Number(blockInfo.timestamp.toString());
      if (timestamp > blockTimestamp) {
        break;
      }
      const diff = blockTimestamp - timestamp;
      predictHeight += Math.ceil(diff / (45 * 1000));
    }
  } else {
    while (true) {
      const blockInfo = await blockRepo.getBlockByHeight(UInt64.fromUint(predictHeight)).toPromise();
      const timestamp = Number(blockInfo.timestamp.toString());
      if (timestamp <= blockTimestamp) {
        break;
      }
      const diff = timestamp - blockTimestamp;
      predictHeight -= Math.ceil(diff / (45 * 1000));
    }
  }

  const result = await blockRepo.search({
    offset: (predictHeight - 1).toString(),
    orderBy: sym.BlockOrderBy.Height,
    pageSize: 100,
    pageNumber: 1,
  }).toPromise();
  const f = result.data.filter(value => (Number(value.timestamp.toString()) >= blockTimestamp));
  return Number(f[0].height.toString());
}

async function searchTransactions(netType, criteria) {
  // リポジトリ設定
  if (!(await setRepository(netType))) {
    return [];
  }

  const pageTxes = await txRepo.search(criteria).toPromise();
  if (typeof pageTxes === "undefined") {
    return [];
  }
  // 最終ページの場合は結果を返却する
  if (pageTxes.isLastPage) {
    return pageTxes.data;
  }
  // 再帰実行で次のページを検索し、結果を結合して返却する
  criteria.pageNumber = typeof criteria.pageNumber === "undefined" ? 2 : criteria.pageNumber + 1;
  return pageTxes.data.concat(await searchTransactions(criteria));
}