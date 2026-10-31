.class public Lcom/trilltuner/app/TClient;
.super Landroid/webkit/WebViewClient;
.source "TClient.java"

# Serve bundled files from a secure, virtual origin. ES module workers, fetch,
# WebAssembly and microphone access all need an origin rather than file://.
# External top-level navigations open in the browser, away from the JS bridge.

.method public constructor <init>()V
    .locals 0
    invoke-direct {p0}, Landroid/webkit/WebViewClient;-><init>()V
    return-void
.end method

.method public shouldInterceptRequest(Landroid/webkit/WebView;Landroid/webkit/WebResourceRequest;)Landroid/webkit/WebResourceResponse;
    .locals 9
    invoke-interface {p2}, Landroid/webkit/WebResourceRequest;->getUrl()Landroid/net/Uri;
    move-result-object v0
    const-string v1, "https"
    invoke-virtual {v0}, Landroid/net/Uri;->getScheme()Ljava/lang/String;
    move-result-object v2
    invoke-virtual {v1, v2}, Ljava/lang/String;->equals(Ljava/lang/Object;)Z
    move-result v2
    if-eqz v2, :not_ours
    const-string v1, "appassets.androidplatform.net"
    invoke-virtual {v0}, Landroid/net/Uri;->getHost()Ljava/lang/String;
    move-result-object v2
    invoke-virtual {v1, v2}, Ljava/lang/String;->equals(Ljava/lang/Object;)Z
    move-result v2
    if-eqz v2, :not_ours
    invoke-virtual {v0}, Landroid/net/Uri;->getPath()Ljava/lang/String;
    move-result-object v3
    if-eqz v3, :not_ours
    const-string v1, ".."
    invoke-virtual {v3, v1}, Ljava/lang/String;->contains(Ljava/lang/CharSequence;)Z
    move-result v2
    if-nez v2, :not_ours
    const-string v1, "\\"
    invoke-virtual {v3, v1}, Ljava/lang/String;->contains(Ljava/lang/CharSequence;)Z
    move-result v2
    if-nez v2, :not_ours
    const/4 v1, 0x1
    invoke-virtual {v3, v1}, Ljava/lang/String;->substring(I)Ljava/lang/String;
    move-result-object v3
    invoke-virtual {v3}, Ljava/lang/String;->isEmpty()Z
    move-result v1
    if-eqz v1, :has_path
    const-string v3, "index.html"
    :has_path
    :try_start
    invoke-virtual {p1}, Landroid/webkit/WebView;->getContext()Landroid/content/Context;
    move-result-object v1
    invoke-virtual {v1}, Landroid/content/Context;->getAssets()Landroid/content/res/AssetManager;
    move-result-object v1
    invoke-virtual {v1, v3}, Landroid/content/res/AssetManager;->open(Ljava/lang/String;)Ljava/io/InputStream;
    move-result-object v4
    const-string v5, "application/octet-stream"
    const/4 v6, 0x0
    const-string v1, ".mjs"
    invoke-virtual {v3, v1}, Ljava/lang/String;->endsWith(Ljava/lang/String;)Z
    move-result v1
    if-nez v1, :javascript
    const-string v1, ".js"
    invoke-virtual {v3, v1}, Ljava/lang/String;->endsWith(Ljava/lang/String;)Z
    move-result v1
    if-nez v1, :javascript
    const-string v1, ".wasm"
    invoke-virtual {v3, v1}, Ljava/lang/String;->endsWith(Ljava/lang/String;)Z
    move-result v1
    if-eqz v1, :html_check
    const-string v5, "application/wasm"
    goto :respond
    :javascript
    const-string v5, "text/javascript"
    const-string v6, "UTF-8"
    goto :respond
    :html_check
    const-string v1, ".html"
    invoke-virtual {v3, v1}, Ljava/lang/String;->endsWith(Ljava/lang/String;)Z
    move-result v1
    if-eqz v1, :css_check
    const-string v5, "text/html"
    const-string v6, "UTF-8"
    goto :respond
    :css_check
    const-string v1, ".css"
    invoke-virtual {v3, v1}, Ljava/lang/String;->endsWith(Ljava/lang/String;)Z
    move-result v1
    if-eqz v1, :json_check
    const-string v5, "text/css"
    const-string v6, "UTF-8"
    goto :respond
    :json_check
    const-string v1, ".json"
    invoke-virtual {v3, v1}, Ljava/lang/String;->endsWith(Ljava/lang/String;)Z
    move-result v1
    if-nez v1, :json
    const-string v1, ".webmanifest"
    invoke-virtual {v3, v1}, Ljava/lang/String;->endsWith(Ljava/lang/String;)Z
    move-result v1
    if-eqz v1, :png_check
    :json
    const-string v5, "application/json"
    const-string v6, "UTF-8"
    goto :respond
    :png_check
    const-string v1, ".png"
    invoke-virtual {v3, v1}, Ljava/lang/String;->endsWith(Ljava/lang/String;)Z
    move-result v1
    if-eqz v1, :svg_check
    const-string v5, "image/png"
    goto :respond
    :svg_check
    const-string v1, ".svg"
    invoke-virtual {v3, v1}, Ljava/lang/String;->endsWith(Ljava/lang/String;)Z
    move-result v1
    if-eqz v1, :font_check
    const-string v5, "image/svg+xml"
    goto :respond
    :font_check
    const-string v1, ".woff2"
    invoke-virtual {v3, v1}, Ljava/lang/String;->endsWith(Ljava/lang/String;)Z
    move-result v1
    if-eqz v1, :respond
    const-string v5, "font/woff2"
    :respond
    new-instance v7, Landroid/webkit/WebResourceResponse;
    invoke-direct {v7, v5, v6, v4}, Landroid/webkit/WebResourceResponse;-><init>(Ljava/lang/String;Ljava/lang/String;Ljava/io/InputStream;)V
    :try_end
    .catch Ljava/io/IOException; {:try_start .. :try_end} :not_ours
    return-object v7
    :not_ours
    const/4 v0, 0x0
    return-object v0
.end method

.method public shouldOverrideUrlLoading(Landroid/webkit/WebView;Landroid/webkit/WebResourceRequest;)Z
    .locals 5
    invoke-interface {p2}, Landroid/webkit/WebResourceRequest;->getUrl()Landroid/net/Uri;
    move-result-object v0
    invoke-virtual {v0}, Landroid/net/Uri;->getHost()Ljava/lang/String;
    move-result-object v1
    const-string v2, "appassets.androidplatform.net"
    invoke-virtual {v2, v1}, Ljava/lang/String;->equals(Ljava/lang/Object;)Z
    move-result v1
    if-eqz v1, :external
    invoke-virtual {v0}, Landroid/net/Uri;->getScheme()Ljava/lang/String;
    move-result-object v1
    const-string v2, "https"
    invoke-virtual {v2, v1}, Ljava/lang/String;->equals(Ljava/lang/Object;)Z
    move-result v1
    if-eqz v1, :external
    const/4 v0, 0x0
    return v0
    :external
    :try_start2
    new-instance v1, Landroid/content/Intent;
    const-string v2, "android.intent.action.VIEW"
    invoke-direct {v1, v2, v0}, Landroid/content/Intent;-><init>(Ljava/lang/String;Landroid/net/Uri;)V
    invoke-virtual {p1}, Landroid/webkit/WebView;->getContext()Landroid/content/Context;
    move-result-object v2
    invoke-virtual {v2, v1}, Landroid/content/Context;->startActivity(Landroid/content/Intent;)V
    :try_end2
    .catch Ljava/lang/Exception; {:try_start2 .. :try_end2} :ignored
    :ignored
    const/4 v0, 0x1
    return v0
.end method
