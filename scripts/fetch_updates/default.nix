{
  flake-utils,
  nixpkgs,
  pyproject-build-systems,
  pyproject-nix,
  uv2nix,
  ...
}:
let
  systems = [
    "aarch64-darwin"
    "x86_64-darwin"
    "aarch64-linux"
    "x86_64-linux"
  ];
in
flake-utils.lib.eachSystem systems (
  system:
  let
    pkgs = import nixpkgs { inherit system; };
    python = pkgs.python312;
    uvWorkspace = uv2nix.lib.workspace.loadWorkspace { workspaceRoot = ./.; };
    overlay = uvWorkspace.mkPyprojectOverlay {
      sourcePreference = "wheel";
    };
    pythonSet =
      (pkgs.callPackage pyproject-nix.build.packages {
        inherit python;
      }).overrideScope
        (
          pkgs.lib.composeManyExtensions [
            pyproject-build-systems.overlays.default
            overlay
          ]
        );
  in
  {
    packages.fetch_updates =
      (pythonSet.mkVirtualEnv "codex_desktop_fetch_updates" uvWorkspace.deps.all).overrideAttrs
        (oldAttrs: {
          meta = (oldAttrs.meta or { }) // {
            mainProgram = "fetch_updates";
          };
        });
  }
)
