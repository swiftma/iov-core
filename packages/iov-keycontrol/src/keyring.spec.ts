import { Ed25519KeyringEntry } from "./keyring";

describe("Keyring", () => {
  describe("Ed25519KeyringEntry", () => {
    it("can be constructed", () => {
      const keyringEntry = new Ed25519KeyringEntry();
      expect(keyringEntry).toBeTruthy();
    });

    it("is empty after construction", done => {
      (async () => {
        const keyringEntry = new Ed25519KeyringEntry();
        expect((await keyringEntry.getIdentities()).length).toEqual(0);
        expect(await keyringEntry.serialize()).toEqual("[]");

        done();
      })();
    });

    it("can create an identity", done => {
      (async () => {
        const keyringEntry = new Ed25519KeyringEntry();
        const newIdentity = await keyringEntry.createIdentity();
        expect((await keyringEntry.getIdentities()).length).toEqual(1);

        const firstIdentity = (await keyringEntry.getIdentities())[0];
        expect(newIdentity.algo).toEqual(firstIdentity.algo);
        expect(newIdentity.data).toEqual(firstIdentity.data);
        expect(newIdentity.nickname).toEqual(firstIdentity.nickname);
        expect(newIdentity.canSign).toEqual(firstIdentity.canSign);

        done();
      })();
    });

    it("can create multiple identities", done => {
      (async () => {
        const keyringEntry = new Ed25519KeyringEntry();
        const newIdentity1 = await keyringEntry.createIdentity(); // 1
        await keyringEntry.createIdentity(); // 2
        await keyringEntry.createIdentity(); // 3
        await keyringEntry.createIdentity(); // 4
        const newIdentity5 = await keyringEntry.createIdentity(); // 5
        expect((await keyringEntry.getIdentities()).length).toEqual(5);

        const firstIdentity = (await keyringEntry.getIdentities())[0];
        expect(newIdentity1.algo).toEqual(firstIdentity.algo);
        expect(newIdentity1.data).toEqual(firstIdentity.data);
        expect(newIdentity1.nickname).toEqual(firstIdentity.nickname);
        expect(newIdentity1.canSign).toEqual(firstIdentity.canSign);

        const lastIdentity = (await keyringEntry.getIdentities())[4];
        expect(newIdentity5.algo).toEqual(lastIdentity.algo);
        expect(newIdentity5.data).toEqual(lastIdentity.data);
        expect(newIdentity5.nickname).toEqual(lastIdentity.nickname);
        expect(newIdentity5.canSign).toEqual(lastIdentity.canSign);

        done();
      })();
    });
  });
});
