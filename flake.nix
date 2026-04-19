{
  description = "codex-hosted dev environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    flake-utils.url = "github:numtide/flake-utils";
    treefmt-nix.url = "github:numtide/treefmt-nix";
  };

  outputs =
    inputs@{ flake-utils, ... }:
    flake-utils.lib.meld inputs [
      ./default.nix
      ./nix/fmt.nix
    ];
}
