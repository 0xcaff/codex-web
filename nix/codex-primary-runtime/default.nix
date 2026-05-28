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
    platform = "linux-x64";
  in
  {
    packages.codex-primary-runtime = pkgs.stdenvNoCC.mkDerivation {
      pname = "codex-primary-runtime";
      inherit version;

      src = pkgs.fetchurl {
        url = "https://persistent.oaistatic.com/codex-primary-runtime/${version}/codex-primary-runtime-${platform}-${version}.tar.xz";
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
