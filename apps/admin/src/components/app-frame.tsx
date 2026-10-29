import { Link, useMatchRoute, useNavigate } from '@tanstack/react-router';
import {
  ChevronDown,
  CircleHelp,
  Globe,
  LogOut,
  Monitor,
  Moon,
  PanelLeft,
  Plus,
  Search,
  Sun,
} from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { PREF_KEYS, readPref, writePref } from '../lib/prefs.js';
import { visibleNav, visibleSections, type NavItem } from '../lib/nav.js';
import { can, type AdminPermission, type Session } from '../lib/session.js';
import { useTheme, type ThemeChoice } from '../lib/theme.js';
import { PLACEHOLDER_WEBSITES, type WebsiteChoice } from '../lib/website.js';
import { Tag } from './ui/badge.js';
import { Button } from './ui/button.js';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './ui/command.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.js';
import { Avatar, Kbd } from './ui/misc.js';
import { Tooltip } from './ui/tooltip.js';

/** The brand mark: a teal square with an M. */
export function BrandMark() {
  return (
    <span
      aria-hidden="true"
      className="grid size-[26px] shrink-0 place-items-center rounded-[7px] bg-primary text-[13px] font-bold text-primary-foreground"
    >
      M
    </span>
  );
}

/** Grouped sidebar, 240 px or 60 px collapsed (Sidebar board). Items follow permissions. */
export function Sidebar({
  session,
  collapsed,
  onToggle,
}: {
  session: Session;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const matchRoute = useMatchRoute();
  const groups = visibleNav(session);
  const isActive = (item: NavItem) =>
    item.to === '/'
      ? Boolean(matchRoute({ to: '/' }))
      : Boolean(matchRoute({ to: item.to, fuzzy: true }));

  return (
    <nav
      aria-label="Main"
      className={cn(
        'sticky top-0 flex h-screen shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-sidebar-border bg-sidebar px-2.5 py-3 text-sidebar-foreground',
        collapsed ? 'w-sidebar-collapsed items-center' : 'w-sidebar',
      )}
    >
      <Link
        to="/"
        className="mb-2 flex h-10 items-center gap-2.5 px-2 text-[15px] font-[650] tracking-[-0.01em]"
        aria-label={collapsed ? 'Muziris admin, Home' : undefined}
      >
        <BrandMark />
        {collapsed ? null : (
          <>
            <span>Muziris</span>
            <Tag className="ml-auto">Admin</Tag>
          </>
        )}
      </Link>
      {groups.map((group, index) => (
        <div
          key={group.label ?? 'top'}
          className={cn('flex flex-col gap-0.5', collapsed && 'items-center')}
        >
          {group.label !== null && !collapsed ? (
            <div className="px-2.5 pt-3.5 pb-1 text-[11.5px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              {group.label}
            </div>
          ) : null}
          {collapsed && index > 0 ? (
            <div className="my-2 h-px w-7 bg-border" aria-hidden="true" />
          ) : null}
          <ul className={cn('flex flex-col gap-0.5', !collapsed && 'w-full')}>
            {group.items.map((item) => {
              const active = isActive(item);
              const link = (
                <Link
                  to={item.to}
                  aria-label={collapsed ? item.label : undefined}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex h-8 items-center gap-2.5 rounded-md text-[13.5px] hover:bg-sidebar-accent',
                    collapsed ? 'w-10 justify-center' : 'px-2.5',
                    active &&
                      'bg-sidebar-accent font-semibold text-sidebar-accent-foreground shadow-[inset_2px_0_0_var(--primary)]',
                  )}
                >
                  <item.icon className="size-4 shrink-0" aria-hidden="true" />
                  {collapsed ? null : <span>{item.label}</span>}
                </Link>
              );
              return (
                <li key={item.to}>
                  {collapsed ? (
                    <Tooltip content={item.label} side="right">
                      {link}
                    </Tooltip>
                  ) : (
                    link
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <div className="flex-1" />
      <button
        type="button"
        onClick={onToggle}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-keyshortcuts="Control+B"
        className={cn(
          'flex h-8 items-center gap-2.5 rounded-md text-[13.5px] text-muted-foreground hover:bg-sidebar-accent',
          collapsed ? 'w-10 justify-center' : 'w-full px-2.5',
        )}
      >
        <PanelLeft className="size-4 shrink-0" aria-hidden="true" />
        {collapsed ? null : (
          <>
            <span>Collapse</span>
            <Kbd className="ml-auto">Ctrl B</Kbd>
          </>
        )}
      </button>
    </nav>
  );
}

const THEMES: { value: ThemeChoice; label: string; icon: ReactNode }[] = [
  { value: 'system', label: 'System', icon: <Monitor aria-hidden="true" /> },
  { value: 'light', label: 'Light', icon: <Sun aria-hidden="true" /> },
  { value: 'dark', label: 'Dark', icon: <Moon aria-hidden="true" /> },
];

/** Top bar: website switcher, search button for the command palette, help, user menu. */
export function TopBar({
  session,
  website,
  onWebsite,
  onOpenPalette,
  onOpenShortcuts,
  onSignOut,
}: {
  session: Session;
  website: WebsiteChoice;
  onWebsite: (website: WebsiteChoice) => void;
  onOpenPalette: () => void;
  onOpenShortcuts: () => void;
  onSignOut: () => void;
}) {
  const { choice, setChoice } = useTheme();
  const themeLabel = THEMES.find((t) => t.value === choice)?.label ?? 'System';
  return (
    <header className="sticky top-0 z-30 flex h-topbar shrink-0 items-center gap-3 border-b bg-background px-5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Website: ${website.name}`}
            className="flex h-[34px] min-w-[230px] items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 text-control"
          >
            <span className="flex items-center gap-2">
              <Globe className="size-4" aria-hidden="true" />
              <span className="font-semibold">{website.name}</span>
              <span className="text-xs text-muted-foreground">{website.meta}</span>
            </span>
            <ChevronDown className="size-3.5" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[260px]">
          <DropdownMenuLabel>Placeholder until the websites API exists</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={website.id}
            onValueChange={(value) => {
              const next = PLACEHOLDER_WEBSITES.find((w) => w.id === value);
              if (next) onWebsite(next);
            }}
          >
            {PLACEHOLDER_WEBSITES.map((w) => (
              <DropdownMenuRadioItem key={w.id} value={w.id}>
                <span className="flex-1">{w.name}</span>
                <span className="text-xs text-muted-foreground">{w.meta}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <p className="m-0 px-2 py-1.5 text-xs text-muted-foreground">
            Sets how money, quantities and dates are shown.
          </p>
        </DropdownMenuContent>
      </DropdownMenu>

      <button
        type="button"
        onClick={onOpenPalette}
        aria-label="Search or jump to, Ctrl K"
        aria-keyshortcuts="Control+K"
        className="flex h-[34px] flex-[0_1_420px] items-center justify-between gap-2 rounded-md border bg-muted px-2.5 text-control text-muted-foreground"
      >
        <span className="flex items-center gap-2">
          <Search className="size-4" aria-hidden="true" />
          Jump to a screen or action…
        </span>
        <span className="flex gap-[3px]">
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>

      <span className="flex-1" />

      <Button
        variant="ghost"
        size="icon"
        aria-label="Help and keyboard shortcuts"
        onClick={onOpenShortcuts}
      >
        <CircleHelp aria-hidden="true" />
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex h-10 items-center gap-2.5 rounded-md pr-1.5 pl-1 hover:bg-muted data-[state=open]:bg-muted"
          >
            <Avatar name={session.user.displayName} />
            <span className="flex flex-col text-left leading-tight whitespace-nowrap">
              <span className="text-[12.5px] font-semibold">{session.user.displayName}</span>
              <span className="text-xs text-muted-foreground">Admin user</span>
            </span>
            <ChevronDown className="size-3.5" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[240px]">
          <DropdownMenuLabel className="font-normal normal-case">
            {session.user.email}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Moon aria-hidden="true" />
              <span className="flex-1">Theme</span>
              <span className="text-xs text-muted-foreground">{themeLabel}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                value={choice}
                onValueChange={(value) => {
                  setChoice(value as ThemeChoice);
                }}
              >
                {THEMES.map((t) => (
                  <DropdownMenuRadioItem key={t.value} value={t.value}>
                    {t.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onSelect={onOpenShortcuts}>
            <CircleHelp aria-hidden="true" />
            <span className="flex-1">Keyboard shortcuts</span>
            <Kbd>?</Kbd>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onSignOut}>
            <LogOut aria-hidden="true" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}

interface PaletteAction {
  label: string;
  to:
    | '/customers'
    | '/customer-groups'
    | '/products'
    | '/categories'
    | '/product-units'
    | '/admin-roles'
    | '/buyer-roles';
  permission: AdminPermission;
}

/** Create actions in the palette; each opens its list with the create form open. */
const ACTIONS: readonly PaletteAction[] = [
  { label: 'New customer', to: '/customers', permission: 'customer.manage' },
  { label: 'New customer group', to: '/customer-groups', permission: 'customer.manage' },
  { label: 'New product', to: '/products', permission: 'product.manage' },
  { label: 'New category', to: '/categories', permission: 'product.manage' },
  { label: 'New product unit', to: '/product-units', permission: 'product.manage' },
  { label: 'New admin role', to: '/admin-roles', permission: 'admin_role.manage' },
  { label: 'New buyer role', to: '/buyer-roles', permission: 'buyer_role.manage' },
];

/** Ctrl K: jump to a screen, start a create action, switch theme. Only what the admin may do. */
export function CommandPalette({
  session,
  open,
  onOpenChange,
}: {
  session: Session;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const { setChoice } = useTheme();
  const go = (action: () => Promise<void> | void) => {
    onOpenChange(false);
    void action();
  };
  const sections = [{ to: '/' as const, label: 'Home', icon: null }, ...visibleSections(session)];
  const actions = ACTIONS.filter((a) => can(session, a.permission));
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay" />
        <DialogPrimitive.Content
          aria-label="Command palette"
          className="fixed top-24 left-1/2 z-50 w-[calc(100%-32px)] max-w-[640px] -translate-x-1/2 overflow-hidden rounded-xl border bg-popover shadow-overlay"
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Type to find a screen or an action. Results are limited to what you may see.
          </DialogPrimitive.Description>
          <Command loop>
            <CommandInput
              large
              placeholder="Search screens and actions"
              aria-label="Search or run a command"
            />
            <CommandList>
              <CommandEmpty>Nothing matches.</CommandEmpty>
              <CommandGroup heading="Go to">
                {sections.map((item) => (
                  <CommandItem
                    key={item.to}
                    value={`Go to ${item.label}`}
                    onSelect={() => {
                      go(() => navigate({ to: item.to }));
                    }}
                  >
                    {item.icon ? <item.icon aria-hidden="true" /> : <Search aria-hidden="true" />}
                    <span className="flex-1">{item.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
              {actions.length > 0 ? (
                <CommandGroup heading="Actions">
                  {actions.map((action) => (
                    <CommandItem
                      key={action.label}
                      value={action.label}
                      onSelect={() => {
                        go(() => navigate({ to: action.to, search: { new: true } }));
                      }}
                    >
                      <Plus aria-hidden="true" />
                      <span className="flex-1">{action.label}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
              <CommandGroup heading="Theme">
                {THEMES.map((t) => (
                  <CommandItem
                    key={t.value}
                    value={`Theme ${t.label}`}
                    onSelect={() => {
                      go(() => {
                        setChoice(t.value);
                      });
                    }}
                  >
                    {t.icon}
                    <span className="flex-1">Theme: {t.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
          <div className="flex h-[38px] items-center gap-4 border-t bg-muted px-3.5 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>to move
            </span>
            <span className="flex items-center gap-1">
              <Kbd>Enter</Kbd>to open
            </span>
            <span className="flex-1" />
            <span>Results limited to what you have permission to view</span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const rows: [string, string[]][] = [
    ['Search screens and actions', ['Ctrl', 'K']],
    ['Collapse or expand the sidebar', ['Ctrl', 'B']],
    ['Show these shortcuts', ['?']],
    ['Close a dialog or menu', ['Esc']],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>On a Mac, Cmd works in place of Ctrl.</DialogDescription>
        </DialogHeader>
        <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-4 gap-y-2.5">
          {rows.map(([label, keys]) => (
            <div key={label} className="contents">
              <dt>{label}</dt>
              <dd className="m-0 flex gap-1">
                {keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}

/** Ctrl or Cmd plus a key, ignoring typing in fields only for the bare "?" shortcut. */
export function useShortcuts(handlers: {
  palette: () => void;
  sidebar: () => void;
  help: () => void;
}) {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const current = ref.current;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && key === 'k') {
        event.preventDefault();
        current.palette();
      } else if (mod && key === 'b') {
        event.preventDefault();
        current.sidebar();
      } else if (event.key === '?' && !mod) {
        const target = event.target as HTMLElement | null;
        const typing = target?.closest('input, textarea, select, [contenteditable="true"]');
        if (!typing) {
          event.preventDefault();
          current.help();
        }
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}

/** Holds the frame's state: the sidebar (remembered) and the open dialogs (not). */
export function useFrameState() {
  const [collapsed, setStoredCollapsed] = useState(
    () => readPref(PREF_KEYS.sidebarCollapsed) === 'true',
  );
  const setCollapsed = (update: (collapsed: boolean) => boolean) => {
    setStoredCollapsed((current) => {
      const next = update(current);
      writePref(PREF_KEYS.sidebarCollapsed, String(next));
      return next;
    });
  };
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  return { collapsed, setCollapsed, paletteOpen, setPaletteOpen, shortcutsOpen, setShortcutsOpen };
}
