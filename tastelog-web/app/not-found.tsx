// app/not-found.tsx
import Link from "next/link";

// shadcn/ui
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Page not found</CardTitle>
          <p className="text-sm text-muted-foreground">
            The page you&apos;re looking for doesn&apos;t exist or was moved.
          </p>
        </CardHeader>

        <CardContent className="flex flex-col gap-3">
          <Button asChild>
            <Link href="/">Go to home</Link>
          </Button>

          <Button asChild variant="outline">
            <Link href="/add">Add a recipe</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
