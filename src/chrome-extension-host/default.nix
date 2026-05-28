{
  flake-utils,
  nixpkgs,
  ...
}:

flake-utils.lib.eachDefaultSystem (
  system:
  let
    pkgs = import nixpkgs { inherit system; };
  in
  {
    packages.codex_chrome_extension_host = pkgs.rustPlatform.buildRustPackage {
      pname = "codex-chrome-extension-host";
      version = "0.2.3-linux-alpha1";

      src = ./.;

      cargoLock = {
        lockFile = ./Cargo.lock;
      };

      meta = {
        description = "Native messaging host for the Codex Chrome extension";
        homepage = "https://github.com/ilysenko/codex-desktop-linux";
        license = pkgs.lib.licenses.mit;
        mainProgram = "codex-chrome-extension-host";
        platforms = pkgs.lib.platforms.unix;
      };
    };
  }
)
