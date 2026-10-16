// Fill these in from Supabase Dashboard -> Project Settings -> API.
// The anon key is designed to be public: all access is enforced by the
// row-level security policies in supabase/schema.sql.
window.APP_CONFIG = {
  supabaseUrl: "https://dxtiqafewxazqivmqaqj.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR4dGlxYWZld3hhenFpdm1xYXFqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIwODAyMTksImV4cCI6MjEwNzY1NjIxOX0.B-VMbWqrcEwgYfiGOjYeCGsGX4YLH18a3jpV_mabRuM",
  appName: "Secure Doc Share",
  signedUrlSeconds: 60, // how long a file download link stays valid

  // Android app (viewing is only allowed inside the app)
  androidPackage: "io.github.rahuldahiya67.securedocshare",
  appScheme: "securedocshare",
  apkUrl: "https://github.com/Rahuldahiya67/secure-doc-share/releases/latest/download/SecureDocShare.apk"
};
