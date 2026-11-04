import { Copy, Download } from 'lucide-react';
import { useMemo, type ComponentProps, type ReactNode } from 'react';
import { toast } from 'sonner';
import { encode } from 'uqr';
import { BrandMark } from './app-frame.js';
import { Tag } from './ui/badge.js';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';

// The pieces of two-factor sign-in (ADR 0026) that the sign-in steps and the Security page
// share. Secrets and recovery codes are held in component state only, never in storage.

/** The card the sign-in steps sit in (SignIn board). */
export function SignInCard({
  title,
  description,
  children,
  wide = false,
}: {
  title: string;
  description: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted p-4">
      <div
        className={`flex w-full flex-col gap-5 rounded-lg border bg-card px-7 py-8 shadow-overlay ${
          wide ? 'max-w-[480px]' : 'max-w-[400px]'
        }`}
      >
        <div className="flex items-center gap-2.5">
          <BrandMark />
          <span className="text-base font-semibold">Muziris</span>
          <Tag>Admin</Tag>
        </div>
        <div>
          <h1 className="m-0 text-xl font-[650]">{title}</h1>
          <p className="m-0 mt-1 text-meta text-muted-foreground">{description}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * A QR code for an otpauth:// link, drawn as SVG from the encoder's modules. Always dark on
 * white with a quiet zone, which phone cameras need, whatever the theme.
 */
export function QrCode({ value, label }: { value: string; label: string }) {
  const { path, size } = useMemo(() => {
    const { data, size: modules } = encode(value, { ecc: 'M', border: 4 });
    let d = '';
    data.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`;
      });
    });
    return { path: d, size: modules };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      className="size-48 shrink-0 rounded-md border bg-white"
      shapeRendering="crispEdges"
    >
      <path d={path} fill="#000" />
    </svg>
  );
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error(`Could not copy the ${what.toLowerCase()}`, {
      description: 'Select it and copy it instead.',
    });
  }
}

/** The secret as text, in groups of four, for an app that cannot scan. */
export function SecretText({ secret }: { secret: string }) {
  const grouped = secret.match(/.{1,4}/g)?.join(' ') ?? secret;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-meta text-muted-foreground">Or enter this setup key</span>
      <div className="flex items-center gap-2">
        <code
          className="min-w-0 flex-1 rounded-md border bg-muted px-2.5 py-1.5 font-mono text-sm break-all select-all"
          aria-label="Setup key"
        >
          {grouped}
        </code>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Copy the setup key"
          onClick={() => void copy(secret, 'Setup key')}
        >
          <Copy aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

/** The six-digit code field, which phones may fill from the authenticator app. */
export function CodeInput(props: Omit<ComponentProps<typeof Input>, 'type'>) {
  return (
    <Input
      {...props}
      type="text"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9 ]*"
      maxLength={7}
      required
      className="font-mono tracking-[0.2em]"
    />
  );
}

/** Recovery codes, shown once, with ways to keep them. */
export function RecoveryCodeList({ codes }: { codes: readonly string[] }) {
  const text = `Muziris admin recovery codes. Each works once.\n\n${codes.join('\n')}\n`;
  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'muziris-recovery-codes.txt';
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="flex flex-col gap-3">
      <ul
        aria-label="Recovery codes"
        className="m-0 grid list-none grid-cols-2 gap-x-6 gap-y-1.5 rounded-md border bg-muted p-4 font-mono text-sm"
      >
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => void copy(codes.join('\n'), 'Codes')}
        >
          <Copy aria-hidden="true" />
          Copy
        </Button>
        <Button type="button" variant="outline" onClick={download}>
          <Download aria-hidden="true" />
          Download
        </Button>
      </div>
    </div>
  );
}
