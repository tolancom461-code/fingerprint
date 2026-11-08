export class VendorAdapterRegistry {
  constructor(adapters = []) {
    this.adapters = [...adapters];
    const vendors = new Set();
    for (const adapter of this.adapters) {
      if (!adapter?.vendor) throw new Error('Every biometric adapter must declare a vendor');
      if (vendors.has(adapter.vendor)) throw new Error(`Duplicate biometric vendor adapter: ${adapter.vendor}`);
      vendors.add(adapter.vendor);
    }
  }

  match(req) {
    return this.adapters.find((adapter) => adapter.matches(req)) ?? null;
  }

  listVendors() {
    return this.adapters.map((adapter) => adapter.vendor);
  }
}
