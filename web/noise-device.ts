export type BrowserDevice = {
	id: string;
	publicKey: number[];
	privateKey: CryptoKey;
};

function usable(value: BrowserDevice | undefined): value is BrowserDevice {
	return (
		!!value &&
		/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value.id) &&
		Array.isArray(value.publicKey) &&
		value.publicKey.length === 65 &&
		value.publicKey[0] === 4 &&
		value.publicKey.every((b) => Number.isInteger(b) && b >= 0 && b <= 255) &&
		value.privateKey instanceof CryptoKey &&
		value.privateKey.type === "private" &&
		!value.privateKey.extractable &&
		value.privateKey.algorithm.name === "ECDSA" &&
		(value.privateKey.algorithm as EcKeyAlgorithm).namedCurve === "P-256" &&
		value.privateKey.usages.length === 1 &&
		value.privateKey.usages[0] === "sign"
	);
}

async function storage<T>(
	mode: IDBTransactionMode,
	action: (store: IDBObjectStore) => IDBRequest<T>,
) {
	const db = await new Promise<IDBDatabase>((resolve, reject) => {
		const req = indexedDB.open("rothcold-noise-devices", 1);
		req.onupgradeneeded = () => req.result.createObjectStore("devices");
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
	try {
		return await new Promise<T>((resolve, reject) => {
			const tx = db.transaction("devices", mode);
			const req = action(tx.objectStore("devices"));
			tx.oncomplete = () => resolve(req.result);
			tx.onabort = () => reject(tx.error);
		});
	} finally {
		db.close();
	}
}
export async function loadDevice(
	scope: string,
): Promise<BrowserDevice | undefined> {
	const device = await storage("readonly", (store) => store.get(scope));
	if (device !== undefined && !usable(device))
		throw new Error("This browser cannot restore the device key securely.");
	return device;
}
export async function saveDevice(scope: string, device: BrowserDevice) {
	if (!usable(device))
		throw new Error(
			"This browser cannot preserve a non-extractable device key.",
		);
	await storage("readwrite", (store) => store.put(device, scope));
}
export async function removeDevice(scope: string, id: string) {
	await storage("readwrite", (store) => {
		const read = store.get(scope);
		read.onsuccess = () => {
			if (read.result?.id === id) store.delete(scope);
		};
		return read;
	});
}
