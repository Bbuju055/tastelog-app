// app/loading.tsx
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export default function GlobalLoading() {
  return (
    <div className="min-h-[60vh] w-full px-4 py-10 sm:py-14">
      <div className="mx-auto w-full max-w-xl space-y-4">
        <Card>
          <CardHeader className="space-y-2">
            <div className="h-6 w-2/3 rounded-md bg-muted animate-pulse" />
            <div className="h-4 w-1/3 rounded-md bg-muted animate-pulse" />
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="h-4 w-full rounded-md bg-muted animate-pulse" />
            <div className="h-4 w-11/12 rounded-md bg-muted animate-pulse" />
            <div className="h-4 w-10/12 rounded-md bg-muted animate-pulse" />
            <div className="pt-2">
              <div className="h-9 w-28 rounded-md bg-muted animate-pulse" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 py-6">
            <div className="h-4 w-1/2 rounded-md bg-muted animate-pulse" />
            <div className="h-4 w-2/3 rounded-md bg-muted animate-pulse" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
