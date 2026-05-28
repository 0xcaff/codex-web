{
  flake-utils,
  nixpkgs,
  ...
}:
flake-utils.lib.eachSystem [ "x86_64-linux" ] (
  system:
  let
    pkgs = import nixpkgs { inherit system; };
  in
  {
    packages.codex-primary-runtime = pkgs.stdenvNoCC.mkDerivation {
      pname = "codex-primary-runtime";
      version = "26.426.12240";

      src = pkgs.fetchurl {
        url = "https://persistent.oaistatic.com/codex-primary-runtime/26.426.12240/codex-primary-runtime-linux-x64-26.426.12240.tar.xz";
        hash = "sha256-21Yk6276NrZuxvbdBIjO+5ZuSWNoYqq2IJpDNsHKkMQ=";
      };

      sourceRoot = "codex-primary-runtime";

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
