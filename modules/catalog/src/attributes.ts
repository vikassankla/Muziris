import { z } from 'zod';

// Product attributes are free-form until attribute definitions (types, units, which ones buyers
// can filter on) are built. Until then the shape is kept narrow: values are text, true or
// false, or a list of texts. Measurements go in as decimal strings ("2.5"), never JSON numbers,
// so no binary float is ever stored.

export const MAX_ATTRIBUTES = 100;
export const MAX_ATTRIBUTE_TEXT_LENGTH = 1000;
export const MAX_ATTRIBUTE_LIST_LENGTH = 50;

const attributeKeySchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{0,62}$/,
    'Use 1 to 63 lowercase letters, digits or _, starting with a letter',
  );

const attributeTextSchema = z.string().trim().min(1).max(MAX_ATTRIBUTE_TEXT_LENGTH);

const attributeValueSchema = z.union([
  attributeTextSchema,
  z.boolean(),
  z.array(attributeTextSchema).min(1).max(MAX_ATTRIBUTE_LIST_LENGTH),
]);

export type ProductAttributeValue = z.infer<typeof attributeValueSchema>;

export type ProductAttributes = Record<string, ProductAttributeValue>;

/** Validates a product's attributes object, as given by the admin or an import. */
export const productAttributesSchema: z.ZodType<ProductAttributes> = z
  .record(attributeKeySchema, attributeValueSchema)
  .refine((value) => Object.keys(value).length <= MAX_ATTRIBUTES, {
    message: `A product can have at most ${MAX_ATTRIBUTES} attributes`,
  });

/**
 * Reads attributes stored in the database. A stored value that no longer matches the schema
 * throws instead of being passed on, as stored settings do (ADR 0003).
 */
export function readStoredAttributes(stored: unknown): ProductAttributes {
  return productAttributesSchema.parse(stored);
}
