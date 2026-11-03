import {
  createCategory,
  createProduct,
  findProductBySku,
  listCategories,
  listProductUnits,
  type ProductAttributes,
} from '@muziris/catalog';
import type { Database } from '@muziris/db';
import { findOrganization, findWebsiteByCode } from '@muziris/platform';
import {
  addPrice,
  createAssignment,
  createPriceList,
  listPriceLists,
  PricingError,
  rebuildCombinedPrices,
} from '@muziris/pricing';
import { rebuildSearchIndex } from '@muziris/search';
import { rebuildVisibility } from '@muziris/visibility';

// The MRO demo catalog: categories, products with HSN codes and US tax categories, and a list
// price per website with quantity breaks, so a new install can be shown and hand tested end to
// end. Every step adds only what is missing, so running it again changes nothing. It never
// adds tax rates or registrations: those are the business's own, entered on System > Tax.

export const DEMO_PRICE_LIST_NAME = 'Demo list price';

interface DemoCategory {
  code: string;
  name: string;
  parent?: string;
}

export const DEMO_CATEGORIES: readonly DemoCategory[] = [
  { code: 'power_transmission', name: 'Power transmission' },
  { code: 'bearings', name: 'Bearings', parent: 'power_transmission' },
  { code: 'belts', name: 'Belts', parent: 'power_transmission' },
  { code: 'fasteners', name: 'Fasteners' },
  { code: 'safety', name: 'Safety' },
  { code: 'tools', name: 'Tools' },
  { code: 'cutting_tools', name: 'Cutting tools', parent: 'tools' },
  { code: 'hand_tools', name: 'Hand tools', parent: 'tools' },
  { code: 'lubricants', name: 'Lubricants' },
  { code: 'electrical', name: 'Electrical' },
];

interface DemoProduct {
  sku: string;
  name: string;
  category: string;
  /** India HSN code, 8 digits. In the US every demo product is taxable (`general`). */
  hsn: string;
  unit: 'each' | 'pack' | 'kg' | 'm' | 'l';
  /** List price for one unit, then the price from 10 and from 100, in INR and in USD. */
  inr: readonly [string, string, string];
  usd: readonly [string, string, string];
  attributes: ProductAttributes;
}

const p = (
  sku: string,
  name: string,
  category: string,
  hsn: string,
  unit: DemoProduct['unit'],
  inr: DemoProduct['inr'],
  usd: DemoProduct['usd'],
  attributes: ProductAttributes,
): DemoProduct => ({ sku, name, category, hsn, unit, inr, usd, attributes });

// prettier-ignore
export const DEMO_PRODUCTS: readonly DemoProduct[] = [
  // Bearings: HSN 8482 10 11, ball bearings of up to 100 mm bore.
  p('BRG-6201-2RS', 'Ball bearing 6201-2RS', 'bearings', '84821011', 'each', ['185.00', '172.00', '158.00'], ['3.20', '2.95', '2.70'], { bore_mm: '12', outer_diameter_mm: '32', width_mm: '10', seal: 'Rubber, both sides' }),
  p('BRG-6203-2RS', 'Ball bearing 6203-2RS', 'bearings', '84821011', 'each', ['220.00', '205.00', '189.00'], ['3.80', '3.55', '3.25'], { bore_mm: '17', outer_diameter_mm: '40', width_mm: '12', seal: 'Rubber, both sides' }),
  p('BRG-6205-2RS', 'Ball bearing 6205-2RS', 'bearings', '84821011', 'each', ['450.00', '430.00', '410.00'], ['12.40', '12.10', '11.95'], { bore_mm: '25', outer_diameter_mm: '52', width_mm: '15', seal: 'Rubber, both sides' }),
  p('BRG-6206-ZZ', 'Ball bearing 6206-ZZ', 'bearings', '84821011', 'each', ['520.00', '495.00', '468.00'], ['13.90', '13.40', '12.80'], { bore_mm: '30', outer_diameter_mm: '62', width_mm: '16', seal: 'Metal shield, both sides' }),
  p('BRG-UCP205', 'Pillow block bearing UCP205', 'bearings', '84829900', 'each', ['890.00', '845.00', '799.00'], ['21.50', '20.40', '19.30'], { bore_mm: '25', housing: 'Cast iron' }),
  p('BRG-32208', 'Tapered roller bearing 32208', 'bearings', '84822090', 'each', ['1250.00', '1190.00', '1125.00'], ['28.00', '26.60', '25.20'], { bore_mm: '40', outer_diameter_mm: '80', width_mm: '24.75' }),
  // Belts: HSN 4010 31 10, V-belts of rubber.
  p('BLT-A42', 'V-belt A42', 'belts', '40103110', 'each', ['210.00', '198.00', '185.00'], ['6.40', '6.05', '5.70'], { section: 'A', inside_length_in: '42' }),
  p('BLT-B60', 'V-belt B60', 'belts', '40103110', 'each', ['340.00', '322.00', '305.00'], ['9.80', '9.30', '8.80'], { section: 'B', inside_length_in: '60' }),
  // Fasteners: HSN 7318, screws, bolts, nuts and washers of steel.
  p('FST-HB-M10X50', 'Hex bolt M10 x 50, grade 8.8, zinc plated (pack of 50)', 'fasteners', '73181500', 'pack', ['640.00', '598.00', '560.00'], ['14.50', '13.60', '12.70'], { thread: 'M10', length_mm: '50', grade: '8.8', finish: 'Zinc plated', pack_quantity: '50' }),
  p('FST-HB-M12X60', 'Hex bolt M12 x 60, grade 8.8, zinc plated (pack of 25)', 'fasteners', '73181500', 'pack', ['715.00', '668.00', '625.00'], ['16.20', '15.20', '14.20'], { thread: 'M12', length_mm: '60', grade: '8.8', finish: 'Zinc plated', pack_quantity: '25' }),
  p('FST-HN-M10', 'Hex nut M10, grade 8, zinc plated (pack of 100)', 'fasteners', '73181600', 'pack', ['290.00', '270.00', '252.00'], ['6.60', '6.15', '5.75'], { thread: 'M10', grade: '8', finish: 'Zinc plated', pack_quantity: '100' }),
  p('FST-FW-M10', 'Flat washer M10, zinc plated (pack of 100)', 'fasteners', '73182200', 'pack', ['145.00', '135.00', '126.00'], ['3.30', '3.05', '2.85'], { size: 'M10', finish: 'Zinc plated', pack_quantity: '100' }),
  p('FST-SS-M8X25', 'Socket head cap screw M8 x 25, stainless A2 (pack of 50)', 'fasteners', '73181500', 'pack', ['820.00', '765.00', '715.00'], ['18.60', '17.40', '16.20'], { thread: 'M8', length_mm: '25', material: 'Stainless steel A2', pack_quantity: '50' }),
  p('FST-AN-M10', 'Anchor bolt M10 x 100 (pack of 20)', 'fasteners', '73181500', 'pack', ['560.00', '525.00', '490.00'], ['12.80', '12.00', '11.20'], { thread: 'M10', length_mm: '100', pack_quantity: '20' }),
  // Safety: gloves HSN 4015, goggles 9004, helmets 6506, ear plugs 3926, hi-vis vests 6211.
  p('SAF-GLV-NIT-L', 'Nitrile gloves, large (box of 100)', 'safety', '40151900', 'pack', ['520.00', '490.00', '460.00'], ['11.50', '10.80', '10.10'], { size: 'L', material: 'Nitrile', powder_free: true, pack_quantity: '100' }),
  p('SAF-GLV-CUT5', 'Cut-resistant gloves, level 5, size 9', 'safety', '61169200', 'each', ['265.00', '248.00', '232.00'], ['7.90', '7.40', '6.90'], { size: '9', cut_level: 'ANSI A5' }),
  p('SAF-GOG-CLR', 'Safety goggles, clear, anti-fog', 'safety', '90049090', 'each', ['180.00', '168.00', '156.00'], ['5.40', '5.05', '4.70'], { lens: 'Clear polycarbonate', anti_fog: true }),
  p('SAF-HLM-YLW', 'Safety helmet with ratchet, yellow', 'safety', '65061010', 'each', ['395.00', '370.00', '345.00'], ['11.80', '11.05', '10.30'], { colour: 'Yellow', suspension: '6-point ratchet' }),
  p('SAF-EAR-200', 'Foam ear plugs, corded (box of 200 pairs)', 'safety', '39269099', 'pack', ['1450.00', '1360.00', '1270.00'], ['32.00', '30.00', '28.00'], { noise_reduction_db: '32', corded: true, pack_quantity: '200' }),
  p('SAF-VST-XL', 'High-visibility vest, orange, XL', 'safety', '62114390', 'each', ['210.00', '196.00', '183.00'], ['6.20', '5.80', '5.40'], { size: 'XL', colour: 'Orange', reflective_tape: true }),
  // Cutting tools: drill bits HSN 8207 50, cutting and grinding discs 6804 22.
  p('CUT-HSS-6', 'HSS drill bit 6 mm', 'cutting_tools', '82075000', 'each', ['48.00', '44.50', '41.00'], ['1.45', '1.35', '1.25'], { diameter_mm: '6', material: 'HSS', shank: 'Straight' }),
  p('CUT-HSS-10', 'HSS drill bit 10 mm', 'cutting_tools', '82075000', 'each', ['96.00', '89.00', '82.00'], ['2.80', '2.60', '2.40'], { diameter_mm: '10', material: 'HSS', shank: 'Straight' }),
  p('CUT-HSS-SET19', 'HSS drill bit set, 1 to 10 mm, 19 pieces', 'cutting_tools', '82075000', 'each', ['1150.00', '1080.00', '1010.00'], ['29.00', '27.20', '25.40'], { pieces: '19', material: 'HSS' }),
  p('CUT-DSC-125', 'Cutting disc 125 x 1 mm, for steel', 'cutting_tools', '68042210', 'each', ['42.00', '38.50', '35.00'], ['1.30', '1.20', '1.10'], { diameter_mm: '125', thickness_mm: '1', for: 'Steel and stainless' }),
  p('CUT-GRD-100', 'Grinding disc 100 x 6 mm', 'cutting_tools', '68042210', 'each', ['58.00', '53.50', '49.00'], ['1.75', '1.62', '1.48'], { diameter_mm: '100', thickness_mm: '6' }),
  // Hand tools: spanners HSN 8204, screwdrivers 8205, pliers 8203, tape measures 9017.
  p('HND-CS-SET12', 'Combination spanner set, 8 to 22 mm, 12 pieces', 'hand_tools', '82041120', 'each', ['1890.00', '1780.00', '1670.00'], ['42.00', '39.60', '37.20'], { pieces: '12', range_mm: '8 to 22', material: 'Chrome vanadium' }),
  p('HND-SD-SET6', 'Screwdriver set, 6 pieces', 'hand_tools', '82054000', 'each', ['540.00', '508.00', '476.00'], ['14.80', '13.90', '13.00'], { pieces: '6', tips: ['Slotted', 'Phillips'] }),
  p('HND-PLR-200', 'Combination pliers 200 mm, insulated', 'hand_tools', '82032000', 'each', ['395.00', '372.00', '349.00'], ['11.20', '10.55', '9.90'], { length_mm: '200', insulated_to_v: '1000' }),
  p('HND-TAPE-5M', 'Measuring tape 5 m', 'hand_tools', '90178010', 'each', ['165.00', '154.00', '143.00'], ['5.20', '4.85', '4.50'], { length_m: '5', blade_width_mm: '19' }),
  p('HND-HAM-500', 'Ball pein hammer 500 g', 'hand_tools', '82052000', 'each', ['325.00', '305.00', '285.00'], ['9.40', '8.80', '8.20'], { head_weight_g: '500', handle: 'Fibreglass' }),
  // Lubricants: oils HSN 2710 19 80, greases 2710 19 90, sprays 3403 19.
  p('LUB-HYD-68', 'Hydraulic oil ISO VG 68', 'lubricants', '27101980', 'l', ['215.00', '199.00', '184.00'], ['5.90', '5.45', '5.05'], { viscosity_grade: 'ISO VG 68' }),
  p('LUB-GRS-EP2', 'Lithium grease EP2', 'lubricants', '27101990', 'kg', ['330.00', '305.00', '282.00'], ['8.80', '8.15', '7.55'], { nlgi_grade: '2', base: 'Lithium' }),
  p('LUB-SPR-400', 'Penetrating spray 400 ml', 'lubricants', '34031900', 'each', ['265.00', '246.00', '228.00'], ['7.10', '6.60', '6.10'], { volume_ml: '400' }),
  // Electrical: cable HSN 8544 49, cable ties 3926 90, insulating tape 3919 10, fuses 8536 10.
  p('ELC-CBL-2.5', 'Copper cable 2.5 mm², single core, red', 'electrical', '85444999', 'm', ['32.00', '29.50', '27.00'], ['0.95', '0.88', '0.81'], { cross_section_mm2: '2.5', cores: '1', colour: 'Red' }),
  p('ELC-CT-200', 'Cable ties 200 x 4.8 mm, black (pack of 100)', 'electrical', '39269099', 'pack', ['145.00', '134.00', '124.00'], ['3.90', '3.60', '3.35'], { length_mm: '200', width_mm: '4.8', colour: 'Black', pack_quantity: '100' }),
  p('ELC-TAPE-BLK', 'PVC insulating tape 19 mm x 20 m, black', 'electrical', '39191000', 'each', ['38.00', '35.00', '32.00'], ['1.15', '1.06', '0.98'], { width_mm: '19', length_m: '20', colour: 'Black' }),
  p('ELC-FUSE-16A', 'Cartridge fuse 16 A (pack of 10)', 'electrical', '85361090', 'pack', ['220.00', '204.00', '189.00'], ['5.80', '5.40', '5.00'], { rating_a: '16', pack_quantity: '10' }),
];

/** The minimum quantities the three prices of a demo product start at. */
const BREAKS = ['1', '10', '100'] as const;

export class DemoSeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DemoSeedError';
  }
}

export interface DemoSeedResult {
  websiteName: string;
  currency: string;
  categoriesAdded: number;
  productsAdded: number;
  /** False when the website already had the demo price list. */
  priceListCreated: boolean;
  pricesAdded: number;
  visibleProductCount: number;
}

/**
 * Adds the demo catalog and its list price on one website, then runs the price, visibility and
 * search builds so buyers see it at once.
 */
export async function seedDemoCatalog(
  db: Database,
  input: { websiteCode: string },
): Promise<DemoSeedResult> {
  if (!(await findOrganization(db))) {
    throw new DemoSeedError('This install has no organization yet: run setup first');
  }
  const website = await findWebsiteByCode(db, input.websiteCode);
  if (!website) {
    throw new DemoSeedError(
      `No website with the code ${input.websiteCode}: create it under System > Websites first`,
    );
  }
  const currency = website.defaultCurrency;
  if (currency !== 'INR' && currency !== 'USD') {
    throw new DemoSeedError(`The demo has prices in INR and USD, not ${currency}`);
  }

  const categoryIds = new Map((await listCategories(db)).map((c) => [c.code, c.id]));
  let categoriesAdded = 0;
  for (const category of DEMO_CATEGORIES) {
    if (categoryIds.has(category.code)) continue;
    const created = await createCategory(db, {
      code: category.code,
      name: category.name,
      parentId: category.parent === undefined ? null : (categoryIds.get(category.parent) ?? null),
    });
    categoryIds.set(category.code, created.id);
    categoriesAdded += 1;
  }

  const units = new Set((await listProductUnits(db)).map((u) => u.code));
  const missingUnits = [...new Set(DEMO_PRODUCTS.map((d) => d.unit))].filter((u) => !units.has(u));
  if (missingUnits.length > 0) {
    throw new DemoSeedError(`Missing product units ${missingUnits.join(', ')}: run setup first`);
  }
  const productIds = new Map<string, string>();
  let productsAdded = 0;
  for (const product of DEMO_PRODUCTS) {
    const existing = await findProductBySku(db, product.sku);
    if (existing) {
      productIds.set(product.sku, existing.id);
      continue;
    }
    const created = await createProduct(db, {
      sku: product.sku,
      name: product.name,
      status: 'enabled',
      categoryId: categoryIds.get(product.category) ?? null,
      attributes: product.attributes,
      hsnSacCode: product.hsn,
      usTaxCategory: 'general',
      primaryUnitCode: product.unit,
    });
    productIds.set(product.sku, created.id);
    productsAdded += 1;
  }

  // One demo price list per currency, shared by the websites in it.
  const name = `${DEMO_PRICE_LIST_NAME} (${currency})`;
  const lists = (await listPriceLists(db, { currency, limit: 200 }, new Date())).priceLists;
  const found = lists.find((l) => l.name === name);
  const priceListCreated = found === undefined;
  const listId = (found ?? (await createPriceList(db, { name, currency }))).id;
  try {
    await createAssignment(db, { priceListId: listId, websiteId: website.id, target: 'website' });
  } catch (error) {
    if (!(error instanceof PricingError && error.code === 'assignment_taken')) throw error;
  }
  let pricesAdded = 0;
  if (priceListCreated) {
    for (const product of DEMO_PRODUCTS) {
      const productId = productIds.get(product.sku);
      if (productId === undefined) throw new Error(`Demo product ${product.sku} is missing`);
      const amounts = currency === 'INR' ? product.inr : product.usd;
      for (const [minQuantity, amount] of BREAKS.map((q, i) => [q, amounts[i]] as const)) {
        if (amount === undefined) throw new Error(`Demo product ${product.sku} lacks a price`);
        await addPrice(db, listId, { productId, unitCode: product.unit, minQuantity, amount });
        pricesAdded += 1;
      }
    }
  }

  await rebuildCombinedPrices(db);
  const visibility = await rebuildVisibility(db);
  await rebuildSearchIndex(db);
  return {
    websiteName: website.name,
    currency,
    categoriesAdded,
    productsAdded,
    priceListCreated,
    pricesAdded,
    visibleProductCount: visibility.visibleProductCount,
  };
}
