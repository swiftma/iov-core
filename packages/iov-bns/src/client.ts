import { Stream } from "xstream";

import {
  Address,
  BcpAccount,
  BcpAccountQuery,
  BcpAtomicSwap,
  BcpAtomicSwapConnection,
  BcpNonce,
  BcpQueryEnvelope,
  BcpSwapQuery,
  BcpTicker,
  BcpTransactionResponse,
  ConfirmedTransaction,
  dummyEnvelope,
  isAddressQuery,
  isQueryBySwapId,
  isQueryBySwapRecipient,
  isQueryBySwapSender,
  OpenSwap,
  SwapClaimTx,
  SwapState,
  SwapTimeoutTx,
  TokenTicker,
  TxReadCodec,
} from "@iov/bcp-types";
import { Encoding } from "@iov/encoding";
import { streamPromise } from "@iov/stream";
import {
  buildTxQuery,
  Client as TendermintClient,
  getHeaderEventHeight,
  getTxEventHeight,
  StatusResponse,
  txCommitSuccess,
  TxEvent,
  TxResponse,
} from "@iov/tendermint-rpc";
import { ChainId, PostableBytes, Tag, TxId, TxQuery } from "@iov/tendermint-types";

import { bnsCodec } from "./bnscodec";
import * as codecImpl from "./codecimpl";
import { InitData, Normalize } from "./normalize";
import { bnsFromOrToTag, bnsNonceTag, bnsSwapQueryTags } from "./tags";
import { Decoder, Keyed, Result } from "./types";
import { arraysEqual, hashIdentifier, isSwapOffer, isSwapRelease } from "./util";

/**
 * Returns a filter that only passes when the
 * value is different than the last one
 */
function onChange<T>(): (val: T) => boolean {
  let oldVal: T | undefined;
  return (val: T): boolean => {
    if (val === oldVal) {
      return false;
    }
    oldVal = val;
    return true;
  };
}

/**
 * Talks directly to the BNS blockchain and exposes the
 * same interface we have with the BCP protocol.
 *
 * We can embed in iov-core process or use this in a BCP-relay
 */
export class Client implements BcpAtomicSwapConnection {
  public static async connect(url: string): Promise<Client> {
    const tm = await TendermintClient.connect(url);
    const initData = await this.initialize(tm);
    return new Client(tm, bnsCodec, initData);
  }

  protected static async initialize(tmClient: TendermintClient): Promise<InitData> {
    const status = await tmClient.status();
    const chainId = status.nodeInfo.network;

    // inlining getAllTickers
    const res = await performQuery(tmClient, "/tokens?prefix", Uint8Array.from([]));
    const parser = parseMap(codecImpl.namecoin.Token, 4);
    const data = res.results.map(parser).map(Normalize.token);

    const toKeyValue = (t: BcpTicker): [string, BcpTicker] => [t.tokenTicker, t];
    const tickers = new Map(data.map(toKeyValue));
    return { chainId, tickers };
  }

  protected readonly tmClient: TendermintClient;
  protected readonly codec: TxReadCodec;
  protected readonly initData: InitData;

  constructor(tmClient: TendermintClient, codec: TxReadCodec, initData: InitData) {
    this.tmClient = tmClient;
    this.codec = codec;
    this.initData = initData;
  }

  public disconnect(): void {
    this.tmClient.disconnect();
  }

  /**
   * The chain ID this connection is connected to
   *
   * We store this info from the initialization, no need to query every time
   */
  public chainId(): ChainId {
    return this.initData.chainId;
  }

  public async height(): Promise<number> {
    const status = await this.status();
    return status.syncInfo.latestBlockHeight;
  }

  public status(): Promise<StatusResponse> {
    return this.tmClient.status();
  }

  public async postTx(tx: PostableBytes): Promise<BcpTransactionResponse> {
    const txresp = await this.tmClient.broadcastTxCommit({ tx });
    if (!txCommitSuccess(txresp)) {
      const { checkTx, deliverTx } = txresp;
      throw new Error(JSON.stringify({ checkTx, deliverTx }, null, 2));
    }

    const message = txresp.deliverTx ? txresp.deliverTx.log : txresp.checkTx.log;
    const result = txresp.deliverTx && txresp.deliverTx.data;
    return {
      metadata: {
        height: txresp.height,
        status: txCommitSuccess(txresp),
      },
      data: {
        txid: txresp.hash,
        message: message || "",
        result: result || new Uint8Array([]),
      },
    };
  }

  public async getTicker(ticker: TokenTicker): Promise<BcpQueryEnvelope<BcpTicker>> {
    const res = await this.query("/tokens", Encoding.toAscii(ticker));
    const parser = parseMap(codecImpl.namecoin.Token, 4);
    const data = res.results.map(parser).map(Normalize.token);
    return dummyEnvelope(data);
  }

  public async getAllTickers(): Promise<BcpQueryEnvelope<BcpTicker>> {
    const res = await this.query("/tokens?prefix", Uint8Array.from([]));
    const parser = parseMap(codecImpl.namecoin.Token, 4);
    const data = res.results.map(parser).map(Normalize.token);
    return dummyEnvelope(data);
  }

  public async getAccount(account: BcpAccountQuery): Promise<BcpQueryEnvelope<BcpAccount>> {
    const res = isAddressQuery(account)
      ? this.query("/wallets", account.address)
      : this.query("/wallets/name", Encoding.toAscii(account.name));
    const parser = parseMap(codecImpl.namecoin.Wallet, 5);
    const parsed = (await res).results.map(parser);
    const data = parsed.map(Normalize.account(this.initData));
    return dummyEnvelope(data);
  }

  public async getNonce(account: BcpAccountQuery): Promise<BcpQueryEnvelope<BcpNonce>> {
    // getAddress will do a lookup from name -> address if needed
    // make this an async function so easier to switch on return value
    const getAddress = async (): Promise<Uint8Array | undefined> => {
      if (isAddressQuery(account)) {
        return account.address;
      }
      const addrRes = await this.getAccount(account);
      if (addrRes.data.length === 0) {
        return undefined;
      }
      return addrRes.data[0].address;
    };

    const addr = await getAddress();
    if (!addr) {
      return dummyEnvelope([]);
    }
    const res = await this.query("/auth", addr);

    const parser = parseMap(codecImpl.sigs.UserData, 5);
    const data = res.results.map(parser).map(Normalize.nonce);
    return dummyEnvelope(data);
  }

  /**
   * All matching swaps that are open (from app state)
   */
  public async getSwapFromState(query: BcpSwapQuery): Promise<BcpQueryEnvelope<BcpAtomicSwap>> {
    const doQuery = (): Promise<QueryResponse> => {
      if (isQueryBySwapId(query)) {
        return this.query("/escrows", query.swapid);
      } else if (isQueryBySwapSender(query)) {
        return this.query("/escrows/sender", query.sender);
      } else if (isQueryBySwapRecipient(query)) {
        return this.query("/escrows/recipient", query.recipient);
      } else {
        // if (isQueryBySwapHash(query))
        return this.query("/escrows/arbiter", hashIdentifier(query.hashlock));
      }
    };

    const res = await doQuery();
    const parser = parseMap(codecImpl.escrow.Escrow, 4); // prefix: "esc:"
    const data = res.results.map(parser).map(Normalize.swapOffer(this.initData));
    return dummyEnvelope(data);
  }

  /**
   * All matching swaps that are open (in app state)
   *
   * To get claimed and returned, we need to look at the transactions.... TODO
   */
  public async getSwap(query: BcpSwapQuery): Promise<BcpQueryEnvelope<BcpAtomicSwap>> {
    // we need to combine them all to see all transactions that affect the query
    const setTxs = await this.searchTx({
      tags: [bnsSwapQueryTags(query, true)],
    });
    const delTxs = await this.searchTx({ tags: [bnsSwapQueryTags(query, false)] });

    // tslint:disable-next-line:readonly-array
    const offers: OpenSwap[] = setTxs.filter(isSwapOffer).map(Normalize.swapOfferFromTx(this.initData));

    // setTxs (esp on secondary index) may be a claim/timeout, delTxs must be a claim/timeout
    const release: ReadonlyArray<SwapClaimTx | SwapTimeoutTx> = [...setTxs, ...delTxs]
      .filter(isSwapRelease)
      .map(x => x.transaction);

    // tslint:disable-next-line:readonly-array
    const settled: BcpAtomicSwap[] = [];
    for (const rel of release) {
      const idx = offers.findIndex(x => arraysEqual(x.data.id, rel.swapId));
      const done = Normalize.settleAtomicSwap(offers[idx], rel);
      offers.splice(idx, 1);
      settled.push(done);
    }

    return dummyEnvelope([...offers, ...settled]);
  }

  /**
   * Emits currentState (getSwap) as a stream, then sends updates for any matching swap
   *
   * This includes an open swap beind claimed/expired as well as a new matching swap being offered
   */
  public watchSwap(query: BcpSwapQuery): Stream<BcpAtomicSwap> {
    // we need to combine them all to see all transactions that affect the query
    const setTxs = this.liveTx({ tags: [bnsSwapQueryTags(query, true)] });
    const delTxs = this.liveTx({ tags: [bnsSwapQueryTags(query, false)] });

    const offers: Stream<OpenSwap> = setTxs.filter(isSwapOffer).map(Normalize.swapOfferFromTx(this.initData));

    // setTxs (esp on secondary index) may be a claim/timeout, delTxs must be a claim/timeout
    const releases: Stream<SwapClaimTx | SwapTimeoutTx> = Stream.merge(setTxs, delTxs)
      .filter(isSwapRelease)
      .map(x => x.transaction);

    // combine them and keep track of internal state in the mapper....
    // tslint:disable-next-line:readonly-array
    const open: OpenSwap[] = [];
    const combiner = (evt: OpenSwap | SwapClaimTx | SwapTimeoutTx): BcpAtomicSwap => {
      switch (evt.kind) {
        case SwapState.Open:
          open.push(evt);
          return evt;
        default:
          // event is a swap claim/timeout, resolve an open swap and return new state
          const idx = open.findIndex(x => arraysEqual(x.data.id, evt.swapId));
          const done = Normalize.settleAtomicSwap(open[idx], evt);
          open.splice(idx, 1);
          return done;
      }
    };

    return Stream.merge(offers, releases).map(combiner);
  }

  public async searchTx(txQuery: TxQuery): Promise<ReadonlyArray<ConfirmedTransaction>> {
    // this will paginate over all transactions, even if multiple pages.
    // FIXME: consider making a streaming interface here, but that will break clients
    const res = await this.tmClient.txSearchAll({ query: buildTxQuery(txQuery) });
    const chainId = await this.chainId();
    const mapper = ({ tx, hash, height, txResult }: TxResponse): ConfirmedTransaction => ({
      height,
      txid: hash as TxId,
      log: txResult.log || "",
      result: txResult.data || new Uint8Array([]),
      ...this.codec.parseBytes(tx, chainId),
    });
    return res.txs.map(mapper);
  }

  /**
   * A stream of all transactions that match the tags from the present moment on
   */
  public listenTx(tags: ReadonlyArray<Tag>): Stream<ConfirmedTransaction> {
    const chainId = this.chainId();
    const txs = this.tmClient.subscribeTx(tags);

    // destructuring ftw (or is it too confusing?)
    const mapper = ({ hash, height, tx, result }: TxEvent): ConfirmedTransaction => ({
      height,
      txid: hash as TxId,
      log: result.log || "",
      result: result.data || new Uint8Array([]),
      ...this.codec.parseBytes(tx, chainId),
    });
    return txs.map(mapper);
  }

  /**
   * Does a search and then subscribes to all future changes.
   *
   * It returns a stream starting the array of all existing transactions
   * and then continuing with live feeds
   */
  public liveTx(txQuery: TxQuery): Stream<ConfirmedTransaction> {
    const history = streamPromise(this.searchTx(txQuery));
    const updates = this.listenTx(txQuery.tags);
    return Stream.merge(history, updates);
  }

  public changeBlock(): Stream<number> {
    return this.tmClient.subscribeNewBlockHeader().map(getHeaderEventHeight);
  }

  /**
   * Emits the blockheight for every block where a tx matching these tags is emitted
   */
  public changeTx(tags: ReadonlyArray<Tag>): Stream<number> {
    return this.tmClient
      .subscribeTx(tags)
      .map(getTxEventHeight)
      .filter(onChange<number>());
  }

  /**
   * A helper that triggers if the balance ever changes
   */
  public changeBalance(addr: Address): Stream<number> {
    return this.changeTx([bnsFromOrToTag(addr)]);
  }

  /**
   * A helper that triggers if the nonce every changes
   */
  public changeNonce(addr: Address): Stream<number> {
    return this.changeTx([bnsNonceTag(addr)]);
  }

  /**
   * Gets current balance and emits an update every time it changes
   */
  public watchAccount(account: BcpAccountQuery): Stream<BcpAccount | undefined> {
    if (!isAddressQuery(account)) {
      throw new Error("watchAccount requires an address, not name, to watch");
    }
    // oneAccount normalizes the BcpEnvelope to just get the
    // one account we want, or undefined if nothing there
    const oneAccount = async (): Promise<BcpAccount | undefined> => {
      const acct = await this.getAccount(account);
      return acct.data.length < 1 ? undefined : acct.data[0];
    };

    return Stream.merge(
      Stream.fromPromise(oneAccount()),
      this.changeBalance(account.address)
        .map(() => Stream.fromPromise(oneAccount()))
        .flatten(),
    );
  }

  /**
   * Gets current nonce and emits an update every time it changes
   */
  public watchNonce(account: BcpAccountQuery): Stream<BcpNonce | undefined> {
    if (!isAddressQuery(account)) {
      throw new Error("watchNonce requires an address, not name, to watch");
    }
    // oneNonce normalizes the BcpEnvelope to just get the
    // one account we want, or undefined if nothing there
    const oneNonce = async (): Promise<BcpNonce | undefined> => {
      const acct = await this.getNonce(account);
      return acct.data.length < 1 ? undefined : acct.data[0];
    };

    return Stream.merge(
      Stream.fromPromise(oneNonce()),
      this.changeNonce(account.address)
        .map(() => Stream.fromPromise(oneNonce()))
        .flatten(),
    );
  }

  protected query(path: string, data: Uint8Array): Promise<QueryResponse> {
    return performQuery(this.tmClient, path, data);
  }
}

/**
 * Performs a query
 *
 * This is pulled out to be used in static initialzers as well
 */
async function performQuery(
  tmClient: TendermintClient,
  path: string,
  data: Uint8Array,
): Promise<QueryResponse> {
  const response = await tmClient.abciQuery({ path, data });
  const keys = codecImpl.app.ResultSet.decode(response.key).results;
  const values = codecImpl.app.ResultSet.decode(response.value).results;
  const results: ReadonlyArray<Result> = zip(keys, values);
  return { height: response.height, results };
}

/* Various helpers for parsing the results of querying abci */

export interface QueryResponse {
  readonly height?: number;
  readonly results: ReadonlyArray<Result>;
}

function parseMap<T extends {}>(decoder: Decoder<T>, sliceKey: number): (res: Result) => T & Keyed {
  const mapper = (res: Result): T & Keyed => {
    const val: T = decoder.decode(res.value);
    // bug: https://github.com/Microsoft/TypeScript/issues/13557
    // workaround from: https://github.com/OfficeDev/office-ui-fabric-react/blob/1dbfc5ee7c38e982282f13ef92884538e7226169/packages/foundation/src/createComponent.tsx#L62-L64
    // tslint:disable-next-line:prefer-object-spread
    return Object.assign({}, val, { _id: res.key.slice(sliceKey) });
  };
  return mapper;
}

/* maybe a bit abstract, but maybe we can reuse... */

interface Join<T, U> {
  readonly key: T;
  readonly value: U;
}

function zip<T, U>(keys: ReadonlyArray<T>, values: ReadonlyArray<U>): ReadonlyArray<Join<T, U>> {
  if (keys.length !== values.length) {
    throw Error("Got " + keys.length + " keys but " + values.length + " values");
  }
  return keys.map((key, i) => ({ key, value: values[i] }));
}
