export const com = (n: number, p = '#', w = 'premise'): string =>
  Array.from({ length: n }, (_, i) => `${p} ${w} ${i}: the reason this value matters`).join('\n')
export const code = (n: number, fmt = (i: number) => `x${i} = ${i}`): string => Array.from({ length: n }, (_, i) => fmt(i)).join('\n')
