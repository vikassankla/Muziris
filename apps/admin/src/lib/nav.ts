import {
  Building2,
  FolderTree,
  Globe,
  House,
  KeyRound,
  Mail,
  Package,
  Ruler,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { can, type AdminPermission, type Session } from './session.js';

export type NavTo =
  | '/'
  | '/orders'
  | '/customers'
  | '/customer-groups'
  | '/products'
  | '/categories'
  | '/product-units'
  | '/admin-roles'
  | '/buyer-roles'
  | '/emails'
  | '/websites'
  | '/settings';

export interface NavItem {
  to: NavTo;
  label: string;
  icon: LucideIcon;
  /** Shown only to admins who hold it; Home needs none. */
  permission?: AdminPermission;
}

export interface NavGroup {
  label: string | null;
  items: NavItem[];
}

/**
 * The sidebar, grouped as on the Sidebar board. Sections the board shows but that have no API
 * yet (Sales: RFQs, quotes; Pricing; Admin users) are left out
 * rather than shown empty; docs/status.md lists them.
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  { label: null, items: [{ to: '/', label: 'Home', icon: House }] },
  {
    label: 'Sales',
    items: [{ to: '/orders', label: 'Orders', icon: ShoppingCart, permission: 'order.view' }],
  },
  {
    label: 'Customers',
    items: [
      { to: '/customers', label: 'Customers', icon: Building2, permission: 'customer.view' },
      {
        to: '/customer-groups',
        label: 'Customer groups',
        icon: Users,
        permission: 'customer.view',
      },
    ],
  },
  {
    label: 'Catalog',
    items: [
      { to: '/products', label: 'Products', icon: Package, permission: 'product.view' },
      { to: '/categories', label: 'Categories', icon: FolderTree, permission: 'product.view' },
      { to: '/product-units', label: 'Product units', icon: Ruler, permission: 'product.view' },
    ],
  },
  {
    label: 'Access control',
    items: [
      {
        to: '/admin-roles',
        label: 'Admin roles',
        icon: ShieldCheck,
        permission: 'admin_role.view',
      },
      { to: '/buyer-roles', label: 'Buyer roles', icon: KeyRound, permission: 'buyer_role.view' },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/websites', label: 'Websites', icon: Globe, permission: 'website.view' },
      { to: '/settings', label: 'Settings', icon: Settings, permission: 'setting.view' },
      { to: '/emails', label: 'Emails', icon: Mail, permission: 'notification.view' },
    ],
  },
];

/** The groups and items this admin may see; empty groups are dropped. */
export function visibleNav(session: Session): NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    label: group.label,
    items: group.items.filter(
      (item) => item.permission === undefined || can(session, item.permission),
    ),
  })).filter((group) => group.items.length > 0);
}

/** Every section this admin may open, Home excluded. */
export function visibleSections(session: Session): NavItem[] {
  return visibleNav(session)
    .flatMap((group) => group.items)
    .filter((item) => item.to !== '/');
}
