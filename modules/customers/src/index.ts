// Public interface of the customers module. Other modules import only from here.
export {
  GST_STATE_CODES,
  gstinCheckCharacter,
  gstinProblem,
  isGstStateCode,
  isUsStateCode,
  isValidGstin,
  normalizePinCode,
  normalizeZipCode,
  US_STATE_CODES,
  type GstinProblem,
  type GstStateCode,
  type UsStateCode,
} from './address-rules.js';
export {
  addAddress,
  listAddresses,
  newAddressSchema,
  type Address,
  type AddressPage,
  type NewAddress,
} from './addresses.js';
export {
  findCustomerForBuyer,
  listAddressesForBuyer,
  listBuyerUsersForBuyer,
  listCustomersForBuyer,
  type BuyerViewer,
} from './buyer-scope.js';
export {
  createBuyerUser,
  findBuyerUser,
  linkBuyerUser,
  listBuyerUsers,
  type BuyerUser,
  type BuyerUserPage,
  type NewBuyerUser,
} from './buyer-users.js';
export {
  createCustomer,
  createCustomerGroup,
  findCustomer,
  listCustomerGroups,
  listCustomers,
  listCustomersQuerySchema,
  listSubsidiaries,
  newCustomerGroupSchema,
  newCustomerSchema,
  setCustomerGroup,
  setCustomerParent,
  type Customer,
  type CustomerGroup,
  type CustomerGroupPage,
  type CustomerPage,
  type ListCustomersQuery,
  type NewCustomer,
  type NewCustomerGroup,
} from './customers.js';
export { CustomerError, type CustomerErrorCode } from './errors.js';
export { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX, pageQuerySchema, type PageQuery } from './page.js';
export { descendantCustomerIds, reachableCustomerIds, type CustomerReach } from './hierarchy.js';
export {
  acceptInvitation,
  createInvitation,
  findPendingInvitation,
  INVITATION_DEFAULT_TTL_MS,
  INVITATION_MAX_TTL_MS,
  INVITATION_MIN_TTL_MS,
  invitationStatus,
  listPendingInvitations,
  newInvitationSchema,
  revokeInvitation,
  type AcceptInvitationInput,
  type CreatedInvitation,
  type Invitation,
  type InvitationPage,
  type InvitationStatus,
  type NewInvitation,
} from './invitations.js';
