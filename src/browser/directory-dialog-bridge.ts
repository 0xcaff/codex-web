export async function chooseOneDirectory(
  openDialog: () => Promise<string | null>,
): Promise<string[]> {
  const path = await openDialog();
  return path ? [path] : [];
}
