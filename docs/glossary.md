# Glossary

Use these terms exactly, in code, APIs, the admin and the storefront. Where a word is ambiguous
in everyday use, this file decides.

| Term                | Meaning                                                                                                                           | Not to be confused with                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Install             | One running copy of Muziris, serving one business                                                                                 | A website                                         |
| Organization        | The business that owns the install. One per install                                                                               | A customer                                        |
| Website             | A storefront the organization runs, with its own domain, country, currency, languages, time zone and units                        | A store view; Muziris has no separate store layer |
| Admin user          | A person on the organization's side who works in the admin (staff, sales rep, manager)                                            | A buyer user                                      |
| Customer            | A company that buys from the organization. Customers can form a hierarchy (parent and subsidiaries)                               | A buyer user, a contact                           |
| Customer group      | A set of customers that share price lists, visibility and settings, for example "Distributors"                                    | A role                                            |
| Buyer user          | A person who signs in to the storefront on behalf of a customer                                                                   | A contact                                         |
| Contact             | A person at a customer recorded in the CRM, who may never sign in                                                                 | A buyer user                                      |
| Buyer role          | A set of storefront permissions with an access level: own records, my customer, my customer and subsidiaries                      | An admin role                                     |
| Scope               | The level a setting or assignment applies at: global, organization, website, customer group, customer                             | A permission scope                                |
| Setting             | A configurable value resolved from the most specific scope to the least (customer, customer group, website, organization, global) | An environment variable                           |
| Feature toggle      | A boolean setting that switches a capability on or off at a scope                                                                 | A setting with other value types                  |
| Product             | Something sold. Types: simple, configurable (has variants), kit (bundle of selectable items)                                      | A SKU, which identifies one product               |
| Product unit        | The unit a product is sold in (each, box of 10, kg) with its decimal precision                                                    | A unit system (metric, imperial)                  |
| Price list          | A set of prices by product, unit, currency and minimum quantity                                                                   | A combined price list                             |
| Combined price list | The precomputed result of a customer's chain of price lists, used for every price lookup                                          | A price list someone edits                        |
| Shopping list       | A saved list of products and quantities. A buyer can keep several                                                                 | A cart; Muziris has no separate cart              |
| RFQ                 | A buyer's request for a quote                                                                                                     | A quote                                           |
| Quote               | The organization's priced offer in reply to an RFQ, or made directly by a sales rep                                               | An order                                          |
| Checkout            | The process that turns a shopping list, quick order or accepted quote into an order                                               | An order                                          |
| Order               | A placed, immutable record of what was bought, at what price and tax                                                              | A checkout                                        |
| Payment term        | Days a customer has to pay an invoice (for example net 30)                                                                        | A payment method                                  |
| Minor units         | Money in its smallest unit (paise, cents) stored as an integer                                                                    | Major units (rupees, dollars)                     |
| Workflow            | A declared set of steps and transitions that a kind of record moves through, such as the order workflow                           | A business process in general                     |
| Workflow instance   | One record's run through a workflow, with its current step                                                                        | A workflow definition                             |
| Step                | A named place a workflow instance can be in, for example submitted or approved. A final step ends the workflow                    | A status field owned by another module            |
| Transition          | A named move from one or more steps to a step, for example approve                                                                | A step                                            |
| Guard               | A condition that must hold for a transition to happen                                                                             | An access-control permission                      |
| Action              | Work done inside a transition's transaction after the step changes                                                                | A transition                                      |
| Transition log      | The append-only history of every transition of a workflow instance                                                                | Application logs                                  |
