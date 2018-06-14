import { Ed25519 } from "@iov/crypto";
import { PostableBytes, SignedTransaction } from "@iov/types";
import { Codec } from "../src";
import { chainId, sendTxJson, sig, signedTxBin, signedTxJson } from "./testdata";

describe("Check codec", () => {
  it("properly encodes transactions", async done => {
    const encoded = await Codec.bytesToPost(signedTxJson);
    expect(Uint8Array.from(encoded)).toEqual(signedTxBin);
    done();
  });

  it("properly decodes transactions", () => {
    const decoded = Codec.parseBytes(signedTxBin as PostableBytes, chainId);
    expect(decoded).toEqual(signedTxJson);
  });

  it("properly generates signbytes", async done => {
    const signBytes = await Codec.bytesToSign(sendTxJson, sig.nonce);
    // it should match the signature
    const pubKey = sig.publicKey.data;
    const valid = await Ed25519.verifySignature(sig.signature, signBytes, pubKey);
    expect(valid).toBeTruthy();
    done();
  });

  it("generates transaction id", async done => {
    const id = await Codec.identifier(signedTxJson);
    expect(id).toBeTruthy();
    expect(id.length).toBe(20);
    done();
  });

  it("round trip works", async done => {
    const verify = async (trial: SignedTransaction) => {
      const encoded = await Codec.bytesToPost(trial);
      // Note: odd work-around.
      // If we don't do this, we get the same data back, but stored
      // as Buffer in node, rather than Uint8Array, so toEqual fails
      const noBuffer = Uint8Array.from(encoded) as PostableBytes;
      const decoded = Codec.parseBytes(noBuffer, trial.transaction.chainId);
      expect(decoded).toEqual(trial);
    };
    await verify(signedTxJson);
    done();
  });
});
