export function openUploadPicker(navigate: () => void, picker: Pick<HTMLInputElement, 'click'> | null | undefined): void {
  navigate();
  picker?.click();
}
