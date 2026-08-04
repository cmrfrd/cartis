import type { Component } from '@expressive/react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

export function FieldRow(props: { label: string; children?: Component.Node }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is nested via children (implicit association)
    <label className="flex flex-col gap-1.5">
      <Label asChild>
        <span className="text-xs uppercase tracking-wide">{props.label}</span>
      </Label>
      {props.children}
    </label>
  );
}

export function Panel(props: { title?: string; children?: Component.Node; className?: string }) {
  return (
    <Card className={`gap-3 py-4 ${props.className ?? ''}`}>
      {props.title && (
        <CardHeader className="px-4">
          <CardTitle className="text-xs uppercase tracking-wide text-ink-dim font-semibold">
            {props.title}
          </CardTitle>
        </CardHeader>
      )}
      <CardContent className="px-4">{props.children}</CardContent>
    </Card>
  );
}

export function TabBar<Id extends string>(props: {
  tabs: readonly { id: Id; label: string }[];
  active: Id;
  onSelect: (id: Id) => void;
}) {
  return (
    <Tabs value={props.active} onValueChange={(id) => props.onSelect(id as Id)}>
      <TabsList>
        {props.tabs.map((tab) => (
          <TabsTrigger key={tab.id} value={tab.id}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

export function Spinner(props: { 'data-testid'?: string }) {
  return (
    <span
      data-testid={props['data-testid']}
      role="status"
      aria-label="loading"
      className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-border border-t-main"
    />
  );
}

export function EmptyState(props: { message: string; hint?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <div className="rounded-base border-2 border-border bg-secondary-background px-5 py-4 shadow-shadow">
        <p className="font-base text-foreground/80 text-sm">{props.message}</p>
        {props.hint && <p className="mt-1 text-foreground/50 text-xs">{props.hint}</p>}
      </div>
    </div>
  );
}

/** Presentation surround for card previews: ambient light + floor shadow.
 *  Lives OUTSIDE the export target so none of it prints. */
export function PreviewStage(props: { children?: Component.Node }) {
  return (
    <div className="relative flex flex-col items-center">
      <div className="-z-10 absolute -inset-16 bg-[radial-gradient(ellipse_at_50%_42%,rgba(212,175,55,0.07),transparent_62%)]" />
      {props.children}
      <div className="mt-[-10px] h-5 w-72 rounded-[50%] bg-black/55 blur-md" />
    </div>
  );
}
