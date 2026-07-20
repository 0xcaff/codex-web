{
  flake-utils,
  nixpkgs,
  ...
}:
flake-utils.lib.eachSystem [ "x86_64-linux" ] (
  system:
  let
    pkgs = import nixpkgs { inherit system; };
    version = "26.426.12240";
  in
  {
    packages.codex-primary-runtime = pkgs.stdenvNoCC.mkDerivation {
      pname = "codex-primary-runtime";
      inherit version;

      # this one random version of codex-primary-runtime has a linux build with
      # node_repl mcp. considered using the macOS binary and emulating with
      # darling but ran into numerous issues with darling's isolation
      # requirements
      src = pkgs.fetchurl {
        url = "https://persistent.oaistatic.com/codex-primary-runtime/${version}/codex-primary-runtime-linux-x64-${version}.tar.xz";
        hash = "sha256-21Yk6276NrZuxvbdBIjO+5ZuSWNoYqq2IJpDNsHKkMQ=";
      };

      sourceRoot = "codex-primary-runtime";

      nativeBuildInputs = [ pkgs.autoPatchelfHook ];

      buildInputs = [
        pkgs.glibc
        pkgs.libxcrypt-legacy
        pkgs.stdenv.cc.cc.lib
        pkgs.zlib
      ];

      dontConfigure = true;
      dontBuild = true;

      installPhase = ''
        runHook preInstall

        mkdir -p "$out"
        cp -R . "$out"/

        runHook postInstall
      '';
    };
  }
)
