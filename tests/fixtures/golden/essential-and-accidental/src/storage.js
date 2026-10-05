export class Storage {
  save() {
    return 1;
  }
}

export class FileStorage extends Storage {
  save() {
    return 2;
  }
}

function neverCalledHelper() {
  return 'old';
}
