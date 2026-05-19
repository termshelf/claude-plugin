{{--
  resources/views/legal/privacy.blade.php

  Renders a TermShelf privacy-policy fragment with ETag-aware caching.
  Wire from a controller:

      // app/Http/Controllers/LegalController.php
      public function privacy()
      {
          // Seeded baseline codes: privacy_policy | imprint | terms | withdrawal | cookie_policy.
          return view('legal.privacy', [
              // Use the bare locale code your workspace publishes under (`de`, `en`).
              'fragment' => $this->fetchTermShelf('privacy_policy', [
                  'locale' => 'de', 'market' => 'DE', 'profile' => 'B2C',
              ]),
          ]);
      }

      protected function fetchTermShelf(string $type, array $params): ?string
      {
          // Use https://api.termshelf.de (German market) or https://api.termshelf.com (international).
          // Both serve the same content — pick whichever matches your TermShelf workspace apex.
          $base        = config('services.termshelf.url', 'https://api.termshelf.de');
          $accountHash = config('services.termshelf.account_hash'); // 10-char Crockford base32
          $siteSlug    = config('services.termshelf.site_slug');    // renaming invalidates the URL
          $key  = "termshelf:{$accountHash}:{$siteSlug}:{$type}:" . md5(http_build_query($params));
          $etag = Cache::get("{$key}:etag", '');

          $resp = Http::withHeaders(['If-None-Match' => $etag])
              ->get("{$base}/v1/delivery/{$accountHash}/{$siteSlug}/documents/{$type}/html", $params);

          if ($resp->status() === 304) {
              return Cache::get("{$key}:body");
          }
          if ($resp->status() === 404) {
              return null;
          }
          $resp->throw();

          Cache::put("{$key}:etag", $resp->header('ETag'), now()->addMinute());
          Cache::put("{$key}:body", $resp->body(),         now()->addMinute());
          return $resp->body();
      }
--}}

<!doctype html>
<html lang="de">
<head>
    <meta charset="utf-8">
    <title>Datenschutzerklärung</title>
    <link rel="stylesheet" href="{{ asset('css/termshelf.css') }}">
</head>
<body>
    <main class="ts-host">
        @if ($fragment)
            {!! $fragment !!}
        @else
            <p>Datenschutzerklärung wird vorbereitet.</p>
        @endif
    </main>
</body>
</html>
