// Fill these in from Supabase Dashboard -> Project Settings -> API.
// The anon key is designed to be public: all access is enforced by the
// row-level security policies in supabase/schema.sql.
window.APP_CONFIG = {
  supabaseUrl: "",      // e.g. "https://abcdxyz.supabase.co"
  supabaseAnonKey: "",  // the "anon public" key
  appName: "Secure Doc Share",
  signedUrlSeconds: 60  // how long a file download link stays valid
};
