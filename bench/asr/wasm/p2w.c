/* Text-only wrapper over phonon-2-c's engine for the browser bench: samples in, transcript out (caller frees). */
#include "phonon2.h"
#include <stdlib.h>
#include <string.h>

char *p2w_transcribe(const P2Engine *e, const float *audio, int n_samples)
{
    P2Result r;
    if (p2_transcribe(e, audio, n_samples, 16000, &r) != 0) return NULL;
    char *text = strdup(r.text);
    p2_result_free(&r);
    return text;
}
