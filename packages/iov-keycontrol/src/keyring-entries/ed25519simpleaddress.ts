import { Slip10Curve, Slip10RawIndex } from "@iov/crypto";

import { KeyringEntryImplementationIdString, LocalIdentity } from "../keyring";
import { Slip10KeyringEntry } from "./slip10";

export class Ed25519SimpleAddressKeyringEntry extends Slip10KeyringEntry {
  // simple wrappers to cast return type
  public static fromEntropy(bip39Entropy: Uint8Array): Ed25519SimpleAddressKeyringEntry {
    return super.fromEntropyWithCurve(
      Slip10Curve.Ed25519,
      bip39Entropy,
      Ed25519SimpleAddressKeyringEntry,
    ) as Ed25519SimpleAddressKeyringEntry;
  }

  public static fromMnemonic(mnemonicString: string): Ed25519SimpleAddressKeyringEntry {
    return super.fromMnemonicWithCurve(
      Slip10Curve.Ed25519,
      mnemonicString,
      Ed25519SimpleAddressKeyringEntry,
    ) as Ed25519SimpleAddressKeyringEntry;
  }

  public readonly implementationId = "ed25519-simpleaddress" as KeyringEntryImplementationIdString;

  /**
   * Creates a simple address identity
   *
   * @param index an index i >= 0 as defined in https://github.com/iov-one/iov-core/blob/master/docs/KeyBase.md#simple-address-derivation
   */
  public createIdentity(index: number): Promise<LocalIdentity> {
    const purpose = 4804438;
    const path: ReadonlyArray<Slip10RawIndex> = [
      Slip10RawIndex.hardened(purpose),
      Slip10RawIndex.hardened(index),
    ];
    return super.createIdentityWithPath(path);
  }

  public clone(): Ed25519SimpleAddressKeyringEntry {
    return new Ed25519SimpleAddressKeyringEntry(this.serialize());
  }
}
