import { Toaster as Sonner } from 'sonner';

/** Toasts: bottom right, 5 seconds, paused on hover (States board). */
export function Toaster({ theme }: { theme: 'light' | 'dark' }) {
  return (
    <Sonner
      theme={theme}
      position="bottom-right"
      duration={5000}
      closeButton
      toastOptions={{
        classNames: {
          toast:
            'w-[360px] rounded-lg border bg-popover text-popover-foreground shadow-overlay text-control',
          description: 'text-meta text-muted-foreground',
        },
      }}
    />
  );
}
